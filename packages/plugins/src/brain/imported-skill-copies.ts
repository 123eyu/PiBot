import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { CapabilityContext, SkillsPort } from "@pibot/brain/kit";
import {
  ConnectorManifestSchema,
  IdSchema,
  RpcError,
  RpcErrorCodes,
  withProgressDeadline,
} from "@pibot/plugins-contract/full";
import { BotsRepo, GroupsRepo, transaction } from "@pibot/storage";
import {
  ImportedSkillCopiesRepo,
  type SkillCopyKey,
  type SkillCopyTarget,
} from "../store/imported-skill-copies.ts";
import type { PluginsRepo } from "../store/index.ts";
import { loadImportedPluginSkills } from "./imported-plugin-skills.ts";

export interface SkillTargets {
  bots: string[];
  groups: string[];
}

const invalid = () => new RpcError(RpcErrorCodes.invalidParams, "skill_target_unavailable");

/** Persistent work is authoritative; the queue only serializes this process's attempts. */
export class ImportedSkillCopies {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly abort = new AbortController();
  private closed = false;
  private pending = 0;
  get idle() {
    return this.pending === 0;
  }
  private readonly repo: ImportedSkillCopiesRepo;
  constructor(
    private readonly ctx: CapabilityContext,
    private readonly plugins: PluginsRepo,
    private readonly actorBotId: string,
  ) {
    this.repo = new ImportedSkillCopiesRepo(ctx.db);
  }
  private current(id: string) {
    const row = this.plugins.get(IdSchema.parse(id));
    if (row?.status !== "installed") throw invalid();
    return row;
  }
  validate(targets: SkillTargets): SkillCopyTarget[] {
    const result: SkillCopyTarget[] = [];
    const bots = new BotsRepo(this.ctx.db);
    for (const id of new Set(targets.bots)) {
      const bot = bots.get(IdSchema.parse(id));
      if (!bot || bot.archivedAt) throw invalid();
      result.push({ target_kind: "bot", target_id: id, bot_id: id });
    }
    const groups = new GroupsRepo(this.ctx.db);
    for (const id of new Set(targets.groups)) {
      const group = groups.get(IdSchema.parse(id));
      // An archived member cannot receive a copy, but it must not block the rest of the group.
      const members = (group?.members ?? []).filter((member) => {
        const bot = bots.get(member.botId);
        return !!bot && !bot.archivedAt;
      });
      if (!members.length) throw invalid();
      for (const member of members)
        result.push({ target_kind: "group", target_id: id, bot_id: member.botId });
    }
    return result;
  }
  /** Called inside the install transaction, so a restart cannot lose the selected recipients. */
  enqueue(id: string, targets: SkillTargets) {
    for (const target of this.validate(targets)) this.repo.enqueue(id, target);
  }
  pendingPage(input: { before?: string; limit?: number }) {
    const page = this.repo.pendingPage(input);
    return {
      ...page,
      items: page.items.map((row) => ({
        installationId: String(row.installationId),
        revision: Number(row.revision),
        name: ConnectorManifestSchema.parse(JSON.parse(String(row.manifest_json))).name,
        unassignedCount: Number(row.unassignedCount),
        pendingTargetCount: Number(row.pendingTargetCount),
        updateCount: Number(row.updateCount),
      })),
    };
  }
  /** Readable for any listed installation, including one being removed. */
  updateCount(id: string) {
    return this.repo.updateCount(id);
  }
  status(id: string) {
    const row = this.current(id);
    const copied = this.repo.copiedCount(id);
    return {
      installationId: id,
      revision: row.revision,
      pendingTargetCount: this.repo.pendingCount(id),
      unassignedCount: Math.max(0, this.plugins.importSkillCount(id) - copied),
      updateCount: this.repo.updateCount(id),
    };
  }
  run(id: string, signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new RpcError(RpcErrorCodes.closed, "skills_stopped"));
    const combined = AbortSignal.any([
      this.abort.signal,
      this.ctx.local.shutdown.signal,
      ...(signal ? [signal] : []),
    ]);
    if (this.pending >= 32)
      return Promise.reject(new RpcError(RpcErrorCodes.busy, "skill_copy_busy"));
    this.pending++;
    const work = this.tail
      .then(() => this.copy(id, combined))
      .finally(() => {
        this.pending--;
      });
    // Each caller owns its rejection. Queue bookkeeping must not detach one.
    this.tail = work.catch(() => undefined);
    return work;
  }
  private async copy(id: string, signal: AbortSignal) {
    return withProgressDeadline(signal, (deadline, touch) =>
      this.copyWithProgress(id, deadline, touch),
    );
  }
  private async copyWithProgress(id: string, deadline: AbortSignal, touch: () => void) {
    const port = this.ctx.ports.get<SkillsPort>("imported-skills");
    if (!port?.copyImported) throw new Error("Imported skill writer unavailable");
    const installation = this.current(id);
    if (installation.sourceKind !== "directory") throw invalid();
    let sources: Awaited<ReturnType<typeof loadImportedPluginSkills>>;
    let invalidSource = false;
    try {
      sources = await loadImportedPluginSkills(
        this.ctx.dataDir,
        id,
        deadline,
        (sourcePath) => {
          invalidSource = true;
          this.failure(id, this.actorBotId, sourcePath);
        },
        touch,
      );
    } catch {
      deadline.throwIfAborted();
      this.failure(id);
      return;
    }
    const prepared: { source: (typeof sources)[number]; digest: string }[] = [];
    for (const source of sources) {
      deadline.throwIfAborted();
      try {
        const hash = createHash("sha256");
        const locale = source.locales.en;
        const entries = source.scannedPackage
          ? [
              { ...source.scannedPackage.skillFile, path: "SKILL.md" },
              ...source.scannedPackage.files,
            ]
          : [{ path: "SKILL.md", content: locale.skillMd }, ...(locale.files ?? [])].map(
              (entry) => ({
                path: entry.path,
                bytes: Buffer.byteLength(entry.content),
                async *chunks() {
                  yield Buffer.from(entry.content);
                },
              }),
            );
        entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        for (const entry of entries) {
          hash.update(JSON.stringify([entry.path, entry.bytes]));
          const original = createHash("sha256"),
            redacted = createHash("sha256");
          const stream = this.ctx.redactor.stream();
          const decoder = new StringDecoder("utf8");
          for await (const data of entry.chunks(deadline)) {
            deadline.throwIfAborted();
            touch();
            hash.update(data);
            const text = decoder.write(data);
            original.update(text);
            redacted.update(stream.push(text));
          }
          const tail = decoder.end();
          original.update(tail);
          redacted.update(stream.push(tail)).update(stream.finish());
          if (original.digest("hex") !== redacted.digest("hex")) throw invalid();
        }
        const digest = hash.digest("hex");
        prepared.push({ source, digest });
      } catch {
        invalidSource = true;
        this.failure(id, this.actorBotId, source.sourcePath);
      }
    }
    let after = "";
    for (;;) {
      deadline.throwIfAborted();
      const targets = this.repo.targets(id, after);
      if (!targets.length) break;
      for (const row of targets) {
        const target = row;
        after = String(row.cursor);
        if (!this.targetAvailable(target)) {
          transaction(this.ctx.db, () => {
            this.repo.abandon(id, target);
            this.abandoned(id, target);
          });
          continue;
        }
        let failed = invalidSource;
        for (const { source, digest } of prepared) {
          deadline.throwIfAborted();
          const key: SkillCopyKey = [
            id,
            source.sourcePath,
            target.target_kind,
            target.target_id,
            target.bot_id,
          ];
          if (this.repo.has(key)) continue;
          // A re-import reuses the copy this target already has; a changed package is only
          // reported as an update, never a second "X (2)" skill or an overwrite of user edits.
          const earlier = this.repo.earlierCopy(installation.pluginId, key);
          if (earlier) {
            this.repo.record(
              key,
              earlier.contentHash,
              earlier.skillId,
              earlier.contentHash === digest ? null : digest,
            );
            continue;
          }
          try {
            await port.copyImported(target.bot_id, source, {
              groupId: target.target_kind === "group" ? target.target_id : undefined,
              signal: deadline,
              onProgress: touch,
              assertCurrent: () => {
                this.current(id);
              },
              afterInsert: (skillId) => this.repo.record(key, digest, skillId),
            });
          } catch {
            deadline.throwIfAborted();
            failed = true;
            this.failure(
              id,
              target.bot_id,
              source.sourcePath,
              target.target_kind === "group" ? target.target_id : undefined,
            );
          }
        }
        this.repo.finishTarget(id, target, failed);
      }
    }
    const current = this.current(id);
    this.ctx.peer.emit("plugins.changed", {
      installationId: id,
      revision: current.revision,
      reason: "access",
    });
  }
  /**
   * A frozen or queued target that can never receive a copy again: a deleted or archived Bot,
   * or a group that is gone or that the Bot no longer belongs to (0092 wrote bot_id='' for an
   * empty group).
   */
  private targetAvailable(target: SkillCopyTarget) {
    if (!IdSchema.safeParse(target.bot_id).success) return false;
    const bot = new BotsRepo(this.ctx.db).get(target.bot_id);
    if (!bot || bot.archivedAt) return false;
    if (target.target_kind === "bot") return true;
    if (!IdSchema.safeParse(target.target_id).success) return false;
    return !!new GroupsRepo(this.ctx.db)
      .get(target.target_id)
      ?.members.some((member) => member.botId === target.bot_id);
  }
  private abandoned(id: string, target: SkillCopyTarget) {
    const botId =
      IdSchema.safeParse(target.bot_id).success && new BotsRepo(this.ctx.db).get(target.bot_id)
        ? target.bot_id
        : this.actorBotId;
    this.ctx.local.approvals.audit.append({
      botId,
      kind: "connector.changed",
      summary: "Imported skill copy abandoned: target unavailable",
      detail: {
        installationId: id,
        reasonCode: "plugin_skill_copy_target_unavailable",
        ...(target.target_kind === "group" && IdSchema.safeParse(target.target_id).success
          ? { groupId: target.target_id }
          : {}),
      },
    });
  }
  /** Rows settled by migration 0095 get their one audit record here, in bounded pages. */
  private auditAbandoned() {
    for (;;) {
      this.abort.signal.throwIfAborted();
      const rows = this.repo.unauditedAbandoned();
      if (!rows.length) return;
      for (const row of rows)
        transaction(this.ctx.db, () => {
          this.abandoned(row.installation_id, row);
          this.repo.markAbandonAudited(row.installation_id, row);
        });
    }
  }
  private failure(id: string, botId = this.actorBotId, sourcePath?: string, groupId?: string) {
    if (!IdSchema.safeParse(botId).success || !new BotsRepo(this.ctx.db).get(botId))
      botId = this.actorBotId;
    this.ctx.local.approvals.audit.append({
      botId,
      kind: "connector.changed",
      summary: "Imported skill copy failed closed",
      detail: {
        installationId: id,
        reasonCode: "plugin_skill_copy_failed",
        ...(sourcePath ? { target: createHash("sha256").update(sourcePath).digest("hex") } : {}),
        ...(groupId && IdSchema.safeParse(groupId).success ? { groupId } : {}),
      },
    });
  }
  private validateFrozen(id: string): boolean {
    if (this.repo.validateFrozen(id)) return true;
    this.failure(id);
    return false;
  }

  async assign(id: string, revision: number, targets: SkillTargets, signal: AbortSignal) {
    transaction(this.ctx.db, () => {
      if (this.current(id).revision !== revision)
        throw new RpcError(RpcErrorCodes.invalidParams, "plugin_revision_conflict");
      if (!targets.bots.length && !targets.groups.length) throw invalid();
      this.validateFrozen(id);
      this.repo.migrationState(id, "done");
      this.enqueue(id, targets);
    });
    await this.run(id, signal);
    return this.status(id);
  }
  async migrate() {
    this.auditAbandoned();
    let after = "";
    for (;;) {
      this.abort.signal.throwIfAborted();
      const rows = this.repo.migrationPage(after);
      if (!rows.length) return;
      for (const row of rows) {
        after = row;
        try {
          if (!this.validateFrozen(after)) continue;
          await this.run(after);
          this.repo.migrationState(after, this.repo.pendingCount(after) > 0 ? "failed" : "done");
        } catch {
          this.abort.signal.throwIfAborted();
          this.ctx.local.shutdown.signal.throwIfAborted();
          this.failure(after);
          this.repo.migrationState(after, "failed");
        }
      }
    }
  }
  async stop() {
    this.closed = true;
    this.abort.abort();
    await this.tail;
  }
}
