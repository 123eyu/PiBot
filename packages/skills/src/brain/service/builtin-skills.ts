import type { PackageFile } from "@pibot/brain/kit";
import { folderEntries, skillFingerprint, skillResourceDigests } from "@pibot/brain/kit";
import type { SkillDocument } from "@pibot/skills-contract/full";
import { transaction } from "@pibot/storage";
import { BuiltinSkillsRepo, type SkillRecord } from "../../store/index.ts";
import { skillFolder } from "./skill-files.ts";
import type { SkillService } from "./skill-service.ts";

export interface BuiltinSkillInput {
  key: string;
  document: SkillDocument;
  files: readonly PackageFile[];
}
type Method = BuiltinSkillInput & { known: ReadonlyMap<string, number> };
/** A row that is a copy of the method: the released version it equals, or undefined = edited. */
type Copy = { record: SkillRecord; version: number | undefined; print: string | undefined };

/** 「周期简报 2」 / 「周期简报 (2)」: numbered names earlier copies and 「复制为我的」 gave to clashing copies. */
const baseName = (name: string) => name.replace(/ (?:\d{1,4}|\(\d{1,4}\))$/, "");

/**
 * A built-in method is one of the Bot's (or group member's) own skills. The trusted
 * sync installs it, merges older copies of the same method into that one row, updates it while
 * the user has not changed it and otherwise only reports 「有新版本」. Imported metadata can never
 * claim a method: only this installer binds a key.
 */
export class BuiltinSkillInstaller {
  private pending = 0;
  get idle() {
    return this.pending === 0;
  }
  private tail: Promise<unknown> = Promise.resolve();
  readonly repo: BuiltinSkillsRepo;
  constructor(private readonly service: SkillService) {
    this.repo = new BuiltinSkillsRepo(service.deps.db, service.groupId);
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    this.pending++;
    const work = this.tail.then(action);
    this.tail = work.catch(() => undefined);
    return work.finally(() => {
      this.pending--;
    });
  }
  install(botId: string, input: BuiltinSkillInput, signal: AbortSignal): Promise<void> {
    return this.serial(async () => {
      signal.throwIfAborted();
      this.service.activeBot(botId);
      // A method the user deleted stays deleted.
      if (this.repo.removed(botId, input.key)) return;
      const method = this.method(botId, input);
      await this.merge(botId, method, signal);
      const current = this.repo.get(botId, method.key);
      if (current) await this.sync(current, method, signal);
      else await this.create(botId, method, signal);
    });
  }
  /** Every method this Bot's role ships, e.g. before a group gets its first own skill. */
  async installAll(botId: string, signal: AbortSignal) {
    for (const method of this.service.builtinMethods(botId)) {
      signal.throwIfAborted();
      await this.install(botId, method, signal);
    }
  }
  private method(botId: string, input: BuiltinSkillInput): Method {
    const known = new Map(
      this.service.builtinMethods(botId).find((item) => item.key === input.key)?.known,
    );
    known.set(skillFingerprint(input.document, input.files), input.document.version ?? 0);
    return { ...input, known };
  }
  /** Fingerprints of a row as saved, under its own and the method's name; undefined = unreadable. */
  private async prints(record: SkillRecord, name: string, signal: AbortSignal) {
    try {
      const document = await this.service.document(record, signal);
      const files = (
        await skillResourceDigests(
          (
            await folderEntries(
              skillFolder(this.service.deps.dataDir, record.botId, this.service.location(record)),
              signal,
            )
          ).files,
          signal,
        )
      ).filter((entry) => entry.path !== "SKILL.md" && !entry.path.startsWith(".SKILL.md."));
      return [document.name, baseName(document.name), name].map((candidate) =>
        skillFingerprint({ ...document, name: candidate }, files),
      );
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
  }
  private copyOf(record: SkillRecord, method: Method, prints: readonly string[]) {
    const own = record.builtin?.digest;
    for (const print of prints) {
      const version = method.known.get(print);
      if (version !== undefined) return { record, version, print };
      if (own && print === own)
        return { record, version: record.builtinState?.version ?? 0, print };
    }
    return { record, version: undefined, print: undefined };
  }
  /**
   * Which language pack a copy belongs to. A copy keeps the language it was installed in
   *, and its fingerprint equals a released version in exactly that language, so the sync
   * follows that language's newer versions instead of replacing the files with the interface
   * language's pack (which would change the prompt entry and break the prompt cache). undefined =
   * equals nothing released (the user edited it) or that language's pack is gone.
   */
  private sameLanguage(record: SkillRecord, method: Method, prints: readonly string[]) {
    const matches = (candidate: Method) => prints.some((print) => candidate.known.has(print));
    if (matches(method)) return method;
    for (const language of ["zh", "en"] as const) {
      const variant = this.service
        .builtinMethods(record.botId, language)
        .find((item) => item.key === method.key);
      if (variant && matches(variant)) return variant;
    }
    return undefined;
  }
  /**
   * 0101 queued the rows that may be another copy of a method. A row is that method when its files
   * equal a released version, or when it is the team template's copy in the method's own folder
   * (then possibly edited). One copy survives — the edited one, else the oldest (the user's
   * original, with its usage) — and the others are disabled and archived, never deleted. Two
   * edited copies are not merged (the user has to choose); an unreadable row stays queued.
   */
  private async merge(botId: string, method: Method, signal: AbortSignal) {
    const candidates = this.repo.mergeCandidates(botId, method.key, method.document.name);
    const current = this.repo.get(botId, method.key);
    if (!candidates.length) {
      if (current) this.repo.clearPending(current.id);
      return;
    }
    const copies: Copy[] = [];
    for (const record of candidates) {
      const prints = await this.prints(record, method.document.name, signal);
      if (!prints) continue;
      const templateFolder = record.source === "team" && record.path === `skills/${method.key}`;
      const target = this.sameLanguage(record, method, prints);
      const copy = target
        ? this.copyOf(record, target, prints)
        : { record, version: undefined, print: undefined };
      if (copy.version === undefined && !templateFolder) this.repo.clearPending(record.id);
      else copies.push(copy);
    }
    if (!copies.length) return;
    if (current) {
      const prints = await this.prints(current, method.document.name, signal);
      if (!prints) return;
      const target = this.sameLanguage(current, method, prints);
      copies.unshift(
        target
          ? this.copyOf(current, target, prints)
          : { record: current, version: undefined, print: undefined },
      );
    }
    const edited = copies.filter((copy) => copy.version === undefined);
    if (edited.length > 1) {
      transaction(this.service.deps.db, () => {
        for (const copy of edited) {
          this.repo.clearPending(copy.record.id);
          this.service.audit(
            botId,
            copy.record.name,
            "builtin_merge_skipped",
            undefined,
            undefined,
            undefined,
            "system",
          );
        }
      });
      return;
    }
    const survivor =
      edited[0] ??
      [...copies].sort((a, b) => (a.record.createdAt < b.record.createdAt ? -1 : 1))[0];
    if (!survivor) return;
    transaction(this.service.deps.db, () => {
      for (const copy of copies) {
        if (copy === survivor) continue;
        this.repo.archive(copy.record.id);
        this.service.audit(
          botId,
          copy.record.name,
          "builtin_archived",
          undefined,
          undefined,
          undefined,
          "system",
        );
        if (copy.record.lastUsedAt)
          this.repo.carryLastUsed(survivor.record.id, copy.record.lastUsedAt);
      }
      this.repo.bind(survivor.record.id, method.key, {
        digest: survivor.print ?? null,
        version: survivor.version ?? null,
        modified: survivor.version === undefined,
      });
      this.service.audit(
        botId,
        survivor.record.name,
        "builtin_merged",
        undefined,
        undefined,
        undefined,
        "system",
      );
    });
    this.service.changed(botId, "updated", survivor.record.id);
  }
  /** Untouched copies follow the app's version; an edited one is only marked as edited. */
  private async sync(record: SkillRecord, method: Method, signal: AbortSignal) {
    const prints = await this.prints(record, method.document.name, signal);
    // Unreadable: nothing on disk is known to be the user's or the app's, so nothing changes.
    if (!prints) return;
    const target = this.sameLanguage(record, method, prints);
    const state = record.builtinState;
    if (!target) {
      if (!state?.modified) {
        this.repo.setState(record.id, { modified: true });
        this.service.changed(record.botId, "updated", record.id);
      }
      return;
    }
    const digest = skillFingerprint(target.document, target.files);
    const version = target.document.version ?? 0;
    const copy = this.copyOf(record, target, prints);
    if (copy.print === digest) {
      if (record.name !== target.document.name && !this.nameTaken(record, target)) {
        await this.replace(record, target, signal, "builtin_renamed");
      } else if (state?.modified || state?.version !== version || record.builtin?.digest !== digest)
        this.repo.setState(record.id, { digest, version, modified: false });
      return;
    }
    if (copy.version !== undefined) {
      await this.replace(record, target, signal, "builtin_updated");
      this.repo.setState(record.id, { updatedVersion: version });
      this.service.changed(record.botId, "updated", record.id);
      return;
    }
    if (!state?.modified) {
      this.repo.setState(record.id, { modified: true });
      this.service.changed(record.botId, "updated", record.id);
    }
  }
  private nameTaken(record: SkillRecord, method: Method) {
    const clash = this.service.repo.findByName(record.botId, method.document.name);
    return !!clash && clash.id !== record.id;
  }
  private async replace(
    record: SkillRecord,
    method: Method,
    signal: AbortSignal,
    reason: "builtin_updated" | "builtin_renamed",
  ) {
    const name = this.nameTaken(record, method) ? record.name : method.document.name;
    await this.service.replace(
      record.botId,
      record.id,
      { ...method.document, name },
      method.files,
      signal,
      reason,
      "system",
    );
    this.repo.setState(record.id, {
      digest: skillFingerprint(method.document, method.files),
      version: method.document.version ?? 0,
      modified: false,
      keptVersion: null,
      updatedVersion: null,
    });
  }
  private async create(botId: string, method: Method, signal: AbortSignal) {
    // An unrelated own skill may hold the method's name; the method then gets a number.
    let name = method.document.name;
    for (let suffix = 2; this.service.repo.findByName(botId, name); suffix++) {
      if (suffix > 1000) throw new Error("builtin_skill_name_limit");
      name = `${method.document.name.slice(0, 73)} ${suffix}`;
    }
    await this.service.create(botId, { ...method.document, name }, "team", {
      files: method.files,
      folder: method.key,
      actor: "system",
      builtin: {
        key: method.key,
        digest: skillFingerprint(method.document, method.files),
        version: method.document.version ?? 0,
      },
      queueSignal: signal,
    });
  }
  /**
   * After a user edit: whether the copy still equals the version it came from. Editing it also
   * means the user has seen the automatic update, so 「已更新到 vN」 goes.
   */
  async refreshModified(record: SkillRecord, signal: AbortSignal) {
    if (!record.builtinKey) return;
    const prints = await this.prints(record, record.name, signal);
    if (!prints) return;
    const digest = record.builtin?.digest;
    this.repo.setState(record.id, {
      modified: !digest || !prints.includes(digest),
      updatedVersion: null,
    });
  }
  async settled() {
    await this.tail;
  }
}
