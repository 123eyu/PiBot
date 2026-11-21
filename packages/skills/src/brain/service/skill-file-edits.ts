import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import type { BrainHost } from "@pibot/brain/kit";
import {
  abortable,
  PackageError,
  type PackageFile,
  packagePath,
  readFolder,
  scriptLike,
  textOf,
} from "@pibot/brain/kit";
import {
  type MethodResults,
  RpcError,
  RpcErrorCodes,
  SKILL_IMPORT_FILE_MAX_BYTES,
  SKILL_IMPORT_MAX_BYTES,
  SKILL_IMPORT_MAX_FILES,
  type SkillFileChange,
  SkillPackageWritePathSchema,
} from "@pibot/skills-contract/full";
import { importError } from "./skill-import.ts";

const invalid = (message: string) => new RpcError(RpcErrorCodes.invalidParams, message);
// An editor can stay open a while; past this the user picks the files again.
const UPLOAD_MS = 30 * 60 * 1000;
const MAX_UPLOADS = 8;
// Two full packages: one open editor plus one being replaced, without holding unbounded memory.
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;
const MAX_PICKED_FILE_BYTES = 5 * 1024 * 1024;

function packageFile(path: string, data: Buffer): PackageFile {
  return { path, data, text: textOf(data) !== undefined, script: scriptLike(path, data) };
}

async function readPickedFile(path: string, signal: AbortSignal): Promise<Buffer> {
  // The user picked this exact file; do not follow a link swapped in after the dialog closed.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw invalid("skill_import_unsafe");
    if (stat.size > MAX_PICKED_FILE_BYTES) throw invalid("skill_import_too_large");
    const data = await file.readFile({ signal });
    if (data.length > MAX_PICKED_FILE_BYTES) throw invalid("skill_import_too_large");
    return data;
  } finally {
    await file.close();
  }
}

/** A picked file or folder as package entries; a folder keeps its own name as the top folder. */
async function readUpload(path: string, from: "file" | "folder", signal: AbortSignal) {
  try {
    if (from === "file") {
      const name = packagePath(basename(path));
      if (!SkillPackageWritePathSchema.safeParse(name).success)
        throw invalid("skill_upload_skill_file");
      return [packageFile(name, await readPickedFile(path, signal))];
    }
    const top = packagePath(basename(path));
    const seen = new Set<string>();
    return (await readFolder(path, signal)).map((entry) => {
      const name = packagePath(`${top}/${entry.path}`);
      // A case-sensitive disk can hold names that would overwrite each other elsewhere.
      if (seen.has(name.toLowerCase())) throw new PackageError("unsafe");
      seen.add(name.toLowerCase());
      return packageFile(name, entry.data);
    });
  } catch (error) {
    if (error instanceof RpcError) throw error;
    if (error instanceof PackageError) importError(error);
    signal.throwIfAborted();
    // A vanished, linked or unreadable pick is the user's file problem, not a Pi Bot bug.
    throw invalid("skill_import_unreadable");
  }
}

/**
 * K2 「上传文件 / 上传文件夹」: picked files stay in brain until the editor saves, so their bytes
 * never pass through the renderer. Bounded in count, bytes and time; the oldest goes first.
 */
export class SkillUploads {
  private readonly uploads = new Map<
    string,
    { files: Map<string, PackageFile>; bytes: number; expiresAt: number }
  >();
  private picking = false;
  get retained() {
    this.prune();
    return this.picking || this.uploads.size > 0;
  }
  constructor(private readonly host: BrainHost) {}
  async pick(
    from: "file" | "folder",
    signal: AbortSignal,
  ): Promise<MethodResults["skills.pickFiles"]> {
    if (this.picking) throw new RpcError(RpcErrorCodes.busy, "skill_picker_busy");
    const picker = from === "folder" ? this.host.pickFolder : this.host.pickFile;
    if (!picker) throw new RpcError(RpcErrorCodes.unsupported, "skill_picker_unavailable");
    this.picking = true;
    try {
      const path = await picker.call(this.host, signal);
      if (!path) return null;
      const files = await abortable(
        readUpload(path, from, signal),
        AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      );
      if (!files.length) throw invalid("skill_upload_empty");
      const bytes = files.reduce((sum, file) => sum + file.data.length, 0);
      this.prune();
      for (const id of this.uploads.keys()) {
        if (this.uploads.size < MAX_UPLOADS && this.total() + bytes <= MAX_UPLOAD_BYTES) break;
        this.uploads.delete(id);
      }
      const uploadId = randomUUID();
      this.uploads.set(uploadId, {
        files: new Map(files.map((file) => [file.path, file])),
        bytes,
        expiresAt: Date.now() + UPLOAD_MS,
      });
      return {
        uploadId,
        files: files.map(({ path, data, script, text }) => ({
          path,
          bytes: data.length,
          script,
          text,
        })),
      };
    } finally {
      this.picking = false;
    }
  }
  private total() {
    let sum = 0;
    for (const entry of this.uploads.values()) sum += entry.bytes;
    return sum;
  }
  private prune() {
    const now = Date.now();
    for (const [id, entry] of this.uploads) if (entry.expiresAt <= now) this.uploads.delete(id);
  }
  /** Bytes of one uploaded file, for a save; an expired or evicted upload must be picked again. */
  take(uploadId: string, path: string): Buffer {
    this.prune();
    const file = this.uploads.get(uploadId)?.files.get(path);
    if (!file) throw invalid("skill_upload_expired");
    return file.data;
  }
  file(uploadId: string, path: string): { path: string; text: string | null } {
    return { path, text: textOf(this.take(uploadId, path)) ?? null };
  }
  /** A saved upload is not needed again; a retry of the same save is answered by its receipt. */
  release(uploadIds: Iterable<string>) {
    for (const id of uploadIds) this.uploads.delete(id);
  }
  dispose() {
    this.uploads.clear();
  }
}

/** Uploads a change list refers to, released once the save that used them committed. */
export function uploadIdsOf(changes: readonly SkillFileChange[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const change of changes ?? []) if ("upload" in change) ids.add(change.upload.uploadId);
  return ids;
}

/**
 * The supporting files after an edit: the saved ones it does not name stay, removals go first,
 * then writes. Paths get the import's rules (NFC, Windows-safe, no case-only clashes, no file
 * where a folder is) and the package the import's limits, counting SKILL.md (`skillBytes`).
 */
export function applyFileChanges(
  existing: readonly { path: string; data: Buffer }[],
  changes: readonly SkillFileChange[],
  skillBytes: number,
  deps: { upload(uploadId: string, path: string): Buffer; redact(text: string): string },
): PackageFile[] {
  const files = new Map(existing.map((file) => [file.path.toLowerCase(), file]));
  const normal = (path: string) => {
    try {
      return packagePath(path);
    } catch {
      throw invalid("skill_files_invalid");
    }
  };
  for (const change of changes)
    if ("remove" in change) files.delete(normal(change.path).toLowerCase());
  for (const change of changes) {
    if ("remove" in change) continue;
    const path = normal(change.path);
    if (!SkillPackageWritePathSchema.safeParse(path).success) throw invalid("skill_files_invalid");
    // Text typed in the editor gets the same redaction as the SKILL.md document; uploaded bytes
    // are kept as picked, exactly like an imported package.
    const data =
      "text" in change
        ? Buffer.from(deps.redact(change.text), "utf8")
        : deps.upload(change.upload.uploadId, change.upload.path);
    files.set(path.toLowerCase(), { path, data });
  }
  if (files.size + 1 > SKILL_IMPORT_MAX_FILES) throw invalid("skill_import_too_many_files");
  let total = skillBytes;
  for (const [key, file] of files) {
    if (file.data.length > SKILL_IMPORT_FILE_MAX_BYTES) throw invalid("skill_import_too_large");
    total += file.data.length;
    const parts = key.split("/");
    for (let depth = 1; depth < parts.length; depth++)
      if (files.has(parts.slice(0, depth).join("/"))) throw invalid("skill_files_invalid");
  }
  if (total > SKILL_IMPORT_MAX_BYTES) throw invalid("skill_import_too_large");
  return [...files.values()]
    .map((file) => packageFile(file.path, file.data))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
