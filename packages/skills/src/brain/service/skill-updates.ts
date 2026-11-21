import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type CapabilityContext,
  folderEntries,
  type RegisterRpc,
  skillResourceDigests,
} from "@pibot/brain/kit";
import {
  RpcError,
  RpcErrorCodes,
  SKILL_UPDATE_TEXT_MAX_CHARS,
  type SkillUpdateState,
  type SkillUpdateSummary,
} from "@pibot/skills-contract/full";
import type { SkillRecord } from "../../store/index.ts";
import { extractLinkArchive, runtimeTag } from "../links/link-archive.ts";
import { downloadArchive } from "../links/link-download.ts";
import { linkFailure } from "../links/link-errors.ts";
import { resolveLink } from "../links/link-source.ts";
import { sharedPackagePath } from "./shared-packages.ts";
import { readSkillFile, skillFolder } from "./skill-files.ts";
import { readImportSource } from "./skill-import.ts";
import type { SkillService } from "./skill-service.ts";
import type { SkillServices } from "./skill-services.ts";

const invalid = (message: string) => new RpcError(RpcErrorCodes.invalidParams, message);
/** Files whose content decides whether a prepared runtime environment can be reused. */
const DEPENDENCY =
  /(?:^|\/)(?:requirements[^/]*\.txt|pyproject\.toml|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;
type Resource = { path: string; digest: string };
type RuntimeTag = SkillUpdateSummary["runtimeBefore"][number];

/** A version may be declared as a number; the record keeps whatever the source states, as text. */
function versionOf(value: string | number | null | undefined, commit?: string | null) {
  return value === null || value === undefined ? (commit ?? null) : String(value);
}
function runtimesOf(files: readonly Resource[]) {
  const tags = new Set<RuntimeTag>();
  for (const file of files) {
    const tag = runtimeTag(file.path);
    if (tag) tags.add(tag);
  }
  return [...tags].sort();
}
function sameDependencies(before: readonly Resource[], after: readonly Resource[]) {
  const pick = (files: readonly Resource[]) =>
    files.filter((file) => DEPENDENCY.test(file.path)).sort((a, b) => (a.path < b.path ? -1 : 1));
  return JSON.stringify(pick(before)) === JSON.stringify(pick(after));
}

/**
 * 「检查更新」, 「更新」 and 「回退到上一版」 for imported skills. Only a user request starts a
 * network download; the check publishes what it found, so the later decision is offline and
 * cannot be invalidated by a source that changed in between.
 */
export class SkillUpdates {
  private readonly root: string;
  private readonly ready: Promise<void>;
  constructor(
    private readonly ctx: CapabilityContext,
    private readonly services: SkillServices,
    private readonly signal: AbortSignal,
  ) {
    this.root = join(ctx.dataDir, "skill-updates");
    // Only this feature's downloads live here; a crash must not leave them for later requests.
    this.ready = rm(this.root, { recursive: true, force: true })
      .then(() => mkdir(this.root, { recursive: true, mode: 0o700 }))
      .then(() => undefined);
    void this.ready.catch(() => undefined);
  }
  private proxy() {
    return this.ctx.local.deps.proxy?.();
  }
  register(handle: RegisterRpc) {
    handle("skills.checkUpdate", ({ groupId, skillId, from }, context) =>
      this.check(groupId, skillId, from, context.signal),
    );
    handle("skills.applyUpdate", ({ groupId, skillId, requestId }, context) =>
      this.services.idempotentWrite(
        requestId,
        { method: "skills.applyUpdate", groupId, skillId },
        context.signal,
        (queueSignal) => this.apply(groupId, skillId, queueSignal),
      ),
    );
    handle("skills.rollbackUpdate", ({ groupId, skillId, requestId }, context) =>
      this.services.idempotentWrite(
        requestId,
        { method: "skills.rollbackUpdate", groupId, skillId },
        context.signal,
        (queueSignal) => this.rollback(groupId, skillId, queueSignal),
      ),
    );
  }
  async check(
    groupId: string | undefined,
    skillId: string,
    from: "file" | "folder" | undefined,
    signal: AbortSignal,
  ): Promise<SkillUpdateState> {
    const skills = this.services.skillsFor(groupId);
    const record = skills.require(skillId);
    skills.activeBot(record.botId);
    const state = skills.updateView(skillId);
    // Only an imported skill has a source to compare with; edited copies record no provenance.
    if (!state) throw invalid("skill_update_unavailable");
    const work = AbortSignal.any([signal, this.signal]);
    const document = await skills.document(record, work);
    await this.ready;
    const directory = await mkdtemp(join(this.root, "check-"));
    try {
      const source = document.linkOrigin
        ? await this.download(document.linkOrigin.url, document.linkOrigin.subpath, directory, work)
        : await this.pick(from, work);
      // A dismissed picker changes nothing, so the previous state is still the true one.
      if (!source) return state;
      const imported = await readImportSource(source.path, source.kind, work, () => {});
      const published = await skills.publishUpdate(imported.pack, work, () => {});
      const checkedAt = new Date().toISOString();
      const unchanged = published.digest === state.digest;
      if (!unchanged) {
        const before = await this.resources(skills, record, work);
        const after = await this.packageResources(skills, published.packageId, work);
        const beforeText = await readSkillFile(
          skills.deps.dataDir,
          record.botId,
          skills.location(record),
        ).catch(() => "");
        const afterText = await readFile(
          join(sharedPackagePath(skills.packages.dataDir, published.packageId), "SKILL.md"),
          "utf8",
        );
        await skills.recordUpdateState(
          skillId,
          () => ({
            sourceVersion: state.sourceVersion,
            digest: state.digest,
            importedAt: state.importedAt,
            checkedAt,
            ...(state.rollback ? { previous: state.rollback } : {}),
            pending: {
              packageId: published.packageId,
              version: versionOf(
                published.document.sourceVersion ?? published.document.version,
                source.commit,
              ),
              digest: published.digest,
              checkedAt,
              summary: summarise(before, after, beforeText, afterText),
            },
          }),
          work,
          {
            packageId: published.packageId,
            document: {
              ...published.document,
              ...(document.linkOrigin ? { linkOrigin: document.linkOrigin } : {}),
            },
          },
        );
      } else {
        // Same source bytes: drop any earlier candidate so the panel cannot offer an old tree.
        await skills.recordUpdateState(
          skillId,
          () => ({
            sourceVersion: state.sourceVersion,
            digest: state.digest,
            importedAt: state.importedAt,
            checkedAt,
            ...(state.rollback ? { previous: state.rollback } : {}),
          }),
          work,
        );
      }
      return this.view(skills, skillId);
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  /** Re-resolves the stored link and extracts the skill it belongs to; never trusts a stale tree. */
  private async download(
    url: string,
    subpath: string,
    directory: string,
    signal: AbortSignal,
  ): Promise<{ path: string; kind: "folder"; commit?: string }> {
    try {
      const { source } = await resolveLink(url, signal, this.proxy());
      const archive = join(directory, "source.zip");
      await downloadArchive(archive, source, signal, () => {}, this.proxy());
      const destination = join(directory, "files");
      await mkdir(destination, { mode: 0o700 });
      const extracted = await extractLinkArchive(
        archive,
        destination,
        source.subpath,
        signal,
        () => {},
      );
      // Prefer the folder this skill came from; an archive holding one skill may have moved it.
      const candidate =
        extracted.candidates.find((item) => item.subpath === subpath) ??
        (extracted.candidates.length === 1 ? extracted.candidates[0] : undefined);
      if (!candidate) throw new RpcError(RpcErrorCodes.unsupported, "skill_link_candidate_missing");
      return {
        path: candidate.path,
        kind: "folder",
        ...(extracted.commit ? { commit: extracted.commit } : {}),
      };
    } catch (error) {
      throw linkFailure(error, signal);
    }
  }
  /**
   * A folder or zip import cannot be re-resolved: the user points at the new copy. The picker is
   * the same one the import flow uses, so an unavailable picker is reported the same way.
   */
  private async pick(
    from: "file" | "folder" | undefined,
    signal: AbortSignal,
  ): Promise<{ path: string; kind: "file" | "folder"; commit?: string } | null> {
    if (!from) throw invalid("skill_update_source_required");
    const path =
      from === "folder"
        ? await this.ctx.host.pickFolder?.(signal)
        : await this.ctx.host.skills?.pickFile(signal);
    if (!(from === "folder" ? this.ctx.host.pickFolder : this.ctx.host.skills))
      throw new RpcError(RpcErrorCodes.unsupported, "skill_picker_unavailable");
    return path ? { path, kind: from } : null;
  }
  private async resources(service: SkillService, record: SkillRecord, signal: AbortSignal) {
    const folder = skillFolder(service.deps.dataDir, record.botId, service.location(record));
    return skillResourceDigests((await folderEntries(folder, signal)).files, signal);
  }
  private async packageResources(service: SkillService, packageId: string, signal: AbortSignal) {
    const folder = sharedPackagePath(service.packages.dataDir, packageId);
    return skillResourceDigests((await folderEntries(folder, signal)).files, signal);
  }
  async apply(
    groupId: string | undefined,
    skillId: string,
    queueSignal?: AbortSignal,
  ): Promise<SkillUpdateState> {
    const skills = this.services.skillsFor(groupId);
    const record = skills.require(skillId);
    const state = skills.updateView(skillId);
    if (!state?.available) throw invalid("skill_update_none");
    const pending = state.available;
    const at = new Date().toISOString();
    await skills.switchPackage(
      skillId,
      pending.packageId,
      (current) => ({
        sourceVersion: pending.version,
        digest: pending.digest,
        importedAt: current?.importedAt ?? at,
        checkedAt: pending.checkedAt,
        // The replaced tree stays referenced only through this record, i.e. for 7 days.
        previous: {
          packageId: record.packageId ?? null,
          version: state.sourceVersion,
          digest: state.digest,
          at,
        },
      }),
      { files: pending.summary.filesAfter },
      queueSignal,
    );
    return this.view(skills, skillId);
  }
  async rollback(
    groupId: string | undefined,
    skillId: string,
    queueSignal?: AbortSignal,
  ): Promise<SkillUpdateState> {
    const skills = this.services.skillsFor(groupId);
    skills.require(skillId);
    const state = skills.updateView(skillId);
    const previous = state?.rollback;
    if (!state || !previous) throw invalid("skill_update_none");
    // A null package is the skill's own folder, which never leaves the disk.
    if (previous.packageId && !skills.packages.has(previous.packageId))
      throw invalid("skill_update_expired");
    await skills.switchPackage(
      skillId,
      previous.packageId ?? undefined,
      (current, now) => ({
        sourceVersion: previous.version,
        digest: previous.digest,
        importedAt: current?.importedAt ?? now,
        checkedAt: current?.checkedAt ?? null,
        // One step back only: the update it undid is not offered again.
        ...(current?.pending ? { pending: current.pending } : {}),
      }),
      undefined,
      queueSignal,
    );
    return this.view(skills, skillId);
  }
  private view(skills: SkillService, skillId: string) {
    const state = skills.updateView(skillId);
    if (!state) throw new RpcError(-32603, "skill_update_unavailable");
    return state;
  }
}

function summarise(
  before: readonly Resource[],
  after: readonly Resource[],
  textBefore: string,
  textAfter: string,
): SkillUpdateSummary {
  const old = new Map(before.map((file) => [file.path, file.digest]));
  const current = new Map(after.map((file) => [file.path, file.digest]));
  let added = 0;
  let modified = 0;
  let removed = 0;
  for (const [path, digest] of current) {
    const was = old.get(path);
    if (was === undefined) added++;
    else if (was !== digest) modified++;
  }
  for (const path of old.keys()) if (!current.has(path)) removed++;
  const runtimeBefore = runtimesOf(before);
  const runtimeAfter = runtimesOf(after);
  return {
    added,
    modified,
    removed,
    // SKILL.md itself always counts: a package is never empty.
    filesBefore: before.length + 1,
    filesAfter: after.length + 1,
    skillTextBefore: textBefore.slice(0, SKILL_UPDATE_TEXT_MAX_CHARS),
    skillTextAfter: textAfter.slice(0, SKILL_UPDATE_TEXT_MAX_CHARS),
    skillTextTruncated:
      textBefore.length > SKILL_UPDATE_TEXT_MAX_CHARS ||
      textAfter.length > SKILL_UPDATE_TEXT_MAX_CHARS,
    runtimeBefore,
    runtimeAfter,
    runtimeNeedsPreparation:
      runtimeBefore.join(",") !== runtimeAfter.join(",") || !sameDependencies(before, after),
  };
}
