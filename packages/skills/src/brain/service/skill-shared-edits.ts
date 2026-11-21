import type { DatabaseSync } from "node:sqlite";
import { copyScannedSkillPackage, scanSkillPackage } from "@pibot/brain/kit";
import {
  RpcError,
  SKILL_IMPORT_MAX_BYTES,
  SKILL_IMPORT_MAX_FILES,
  type Skill,
  type SkillDocument,
  type SkillDocumentInput,
  type SkillDocumentPatch,
  type SkillFileChange,
  withProgressDeadline,
} from "@pibot/skills-contract/full";
import { transaction } from "@pibot/storage";
import { type SkillRecord, type SkillRepository, toSkill } from "../../store/index.ts";
import { type PackageWrite, writeSkillPackage } from "./skill-files.ts";
import type { SkillService } from "./skill-service.ts";
import { replaceImportedBody, sourceSkillText } from "./skill-source-text.ts";

const invalid = (message: string) => new RpcError(-32602, message);
interface CopyContext {
  require(id: string): SkillRecord;
  activeBot(id: string): unknown;
  folder(record: SkillRecord): string;
  document(record: SkillRecord): Promise<SkillDocument>;
  create: SkillService["create"];
  preservesSource(record: SkillRecord): boolean;
}
interface EditContext extends Omit<CopyContext, "create" | "preservesSource"> {
  dataDir: string;
  db: DatabaseSync;
  repo: SkillRepository;
  clean(input: SkillDocumentInput): SkillDocument;
  canonicalContract(input: unknown): string;
  editedFiles(
    existing: readonly { path: string; data: Buffer }[],
    changes: readonly SkillFileChange[],
    text: string,
  ): ReturnType<typeof import("./skill-file-edits.ts").applyFileChanges>;
  saveMetadata(record: SkillRecord, packageId: string | undefined, document: SkillDocument): void;
  audit(botId: string, name: string): void;
  settleWrite(write: PackageWrite | undefined): Promise<void>;
  release(changes: readonly SkillFileChange[]): void;
  changed(botId: string, id: string): void;
}
export async function copySkillAsOwn(
  ctx: CopyContext,
  id: string,
  botId: string,
  signal: AbortSignal,
): Promise<Skill> {
  const record = ctx.require(id);
  if (record.botId !== botId) throw invalid("skill_not_found");
  ctx.activeBot(botId);
  return withProgressDeadline(signal, async (deadline, touch) => {
    const pack = await scanSkillPackage(ctx.folder(record), "folder", deadline, touch);
    const document = await ctx.document(record);
    return ctx.create(botId, document, "taught", {
      uniqueName: true,
      scannedPackage: pack,
      preserveSource: ctx.preservesSource(record),
      copySignal: deadline,
      queueSignal: deadline,
    });
  });
}

export async function editSharedSkill(
  ctx: EditContext,
  record: SkillRecord,
  patch: SkillDocumentPatch,
  signal: AbortSignal | undefined,
  changes: readonly SkillFileChange[] = [],
): Promise<Skill> {
  const current = await ctx.document(record);
  const { contract, ...fields } = patch;
  const next = ctx.clean({
    ...current,
    ...fields,
    ...(contract === undefined
      ? {}
      : {
          contract: ctx.canonicalContract(contract),
          version: (current.version ?? 0) + 1,
          verified: undefined,
        }),
  });
  const clash = ctx.repo.findByName(record.botId, next.name);
  if (clash && clash.id !== record.id) throw invalid("skill_name_exists");
  if (!changes.length && (patch.body === undefined || patch.body === current.body)) {
    transaction(ctx.db, () => {
      signal?.throwIfAborted();
      ctx.activeBot(record.botId);
      ctx.repo.updateMeta(record.id, { name: next.name, description: next.description });
      ctx.saveMetadata(record, record.packageId, next);
      ctx.repo.touchUpdated(record.id);
      ctx.audit(record.botId, next.name);
    });
    ctx.changed(record.botId, record.id);
    return toSkill(ctx.require(record.id));
  }
  const write = await withProgressDeadline(
    signal ?? new AbortController().signal,
    async (deadline, touch) => {
      const pack = await scanSkillPackage(ctx.folder(record), "folder", deadline, touch);
      const original = await sourceSkillText(pack, deadline, touch);
      const text =
        patch.body === undefined || patch.body === current.body
          ? original
          : replaceImportedBody(original, next.body);
      const files = ctx.editedFiles([], changes, text);
      const changed = new Set(changes.map((change) => change.path.normalize("NFC").toLowerCase()));
      const kept = pack.files.filter((file) => !changed.has(file.path.toLowerCase()));
      const entries = [
        ...kept.map((file) => ({ path: file.path, bytes: file.bytes })),
        ...files.map((file) => ({ path: file.path, bytes: file.data.length })),
      ];
      if (
        entries.length + 1 > SKILL_IMPORT_MAX_FILES ||
        entries.reduce((sum, file) => sum + file.bytes, Buffer.byteLength(text)) >
          SKILL_IMPORT_MAX_BYTES
      )
        throw invalid("skill_import_too_large");
      const names = new Set(entries.map((file) => file.path.toLowerCase()));
      for (const entry of entries) {
        const parts = entry.path.toLowerCase().split("/");
        for (let i = 1; i < parts.length; i++)
          if (names.has(parts.slice(0, i).join("/"))) throw invalid("skill_files_invalid");
      }
      return writeSkillPackage(
        ctx.dataDir,
        record.botId,
        record.path,
        text,
        files,
        (stage) => copyScannedSkillPackage({ ...pack, files: kept }, stage, deadline, touch),
        deadline,
      );
    },
  );
  try {
    transaction(ctx.db, () => {
      signal?.throwIfAborted();
      ctx.activeBot(record.botId);
      ctx.repo.updateMeta(record.id, { name: next.name, description: next.description });
      ctx.repo.setPackage(record.id, undefined);
      ctx.saveMetadata(record, undefined, next);
      ctx.repo.touchUpdated(record.id);
      ctx.audit(record.botId, next.name);
    });
  } catch (error) {
    await write.rollback();
    throw error;
  }
  await ctx.settleWrite(write);
  ctx.release(changes);
  ctx.changed(record.botId, record.id);
  return toSkill(ctx.require(record.id));
}
