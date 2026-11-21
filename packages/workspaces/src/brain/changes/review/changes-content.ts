import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { imageDimensions } from "@pibot/brain/kit";
import { containsPath } from "@pibot/policy";
import {
  type ChangesImageSide,
  type MethodParams,
  RpcError,
  RpcErrorCodes,
  THUMBNAIL_BYTES,
} from "@pibot/workspaces-contract/full";
import type { ChangesScope } from "../changes-scope.ts";
import { changesError } from "../changes-scope.ts";
import type { ChangesService } from "../changes-service.ts";
import { read } from "../git/changes-repo.ts";
import { checkRun, repo, statusEntry } from "./changes-diff.ts";

/**
 * File contents for the changes sidebar, read-only and size-limited. Git objects go
 * through the hardened reader; working-tree and "this turn" files are read here after a
 * no-symlink, inside-the-folder check. Nothing here follows a renderer-supplied absolute path.
 */
/** Expanding unchanged lines re-reads the newer side; bigger files simply cannot expand. */
const LINES_BYTES = 4 * 1024 * 1024;
/** Same ceiling as image attachments; the original never leaves brain, only a thumbnail does. */
const IMAGE_BYTES = 10 * 1024 * 1024;

type Content =
  | { state: "ok"; bytes: Buffer }
  | { state: "missing" }
  | { state: "too_large"; size: number };
type Source = Pick<MethodParams["changes.lines"], "path" | "scope" | "commit" | "runId">;

/** Opens without following a final symlink and only inside `root` (checked on the real path). */
async function folderFile(
  platform: ChangesService["platform"],
  root: string,
  relativePath: string,
  limit: number,
): Promise<Content> {
  const absolute = join(root, ...relativePath.split("/"));
  const info = await lstat(absolute).catch(() => undefined);
  if (!info) return { state: "missing" };
  if (!info.isFile()) return { state: "missing" };
  const real = await realpath(absolute);
  if (!containsPath(await realpath(root), real, platform)) throw changesError("changes_stale");
  if (info.size > limit) return { state: "too_large", size: info.size };
  const handle = await open(
    real,
    constants.O_RDONLY | (platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { state: "missing" };
    if (stat.size > limit) return { state: "too_large", size: stat.size };
    return { state: "ok", bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

async function blob(
  service: ChangesService,
  cwd: string,
  operation: { commit: string; parent?: boolean; path: string },
  limit: number,
  signal: AbortSignal,
): Promise<Content> {
  const result = await read(() =>
    service.reader.run(
      { op: "blob", ...operation },
      { cwd, signal, maxBytes: limit, timeoutMs: 20_000 },
    ),
  );
  if (result.overflow) return { state: "too_large", size: limit + 1 };
  // A path missing at that commit (or no parent) exits 128: the file did not exist on that side.
  return result.exitCode === 0 ? { state: "ok", bytes: result.stdout } : { state: "missing" };
}

export type ContentSource = Pick<
  MethodParams["changes.lines"],
  "path" | "scope" | "commit" | "runId"
>;
export async function content(
  service: ChangesService,
  scope: ChangesScope,
  source: ContentSource,
  side: "before" | "after",
  limit: number,
  signal: AbortSignal,
): Promise<Content> {
  const root = scope.root.path;
  if (source.scope === "turn") {
    const runId = source.runId as string;
    checkRun(service, scope, runId);
    const file = service.turn.repo.summarize(runId).find((item) => item.path === source.path);
    if (!file) throw changesError("changes_stale");
    const ref = side === "before" ? file.beforeRef : file.afterRef;
    if (!ref) return { state: "missing" };
    const dir = service.turn.snapshotDir(service.turn.repo.botOf(runId) as string, runId);
    const bytes = await readFile(join(dir, ref)).catch(() => undefined);
    if (!bytes) return { state: "missing" };
    return bytes.length > limit
      ? { state: "too_large", size: bytes.length }
      : { state: "ok", bytes };
  }
  const info = await repo(service, scope, signal);
  if (source.scope === "commit")
    return blob(
      service,
      root,
      { commit: source.commit as string, parent: side === "before", path: source.path },
      limit,
      signal,
    );
  const entry = await statusEntry(service, scope, info, source.path, signal);
  if (side === "after")
    return entry.status === "deleted"
      ? { state: "missing" }
      : folderFile(service.platform, root, source.path, limit);
  if (!entry.inHead) return { state: "missing" };
  const head = await read(() =>
    service.reader.run({ op: "head" }, { cwd: root, signal, timeoutMs: 5000 }),
  );
  if (head.exitCode !== 0) return { state: "missing" };
  return blob(
    service,
    root,
    { commit: head.stdout.toString("utf8").trim(), path: source.path },
    limit,
    signal,
  );
}

export async function changesLines(
  service: ChangesService,
  params: MethodParams["changes.lines"],
  signal: AbortSignal,
) {
  const scope = await service.scope(params, signal);
  const file = await content(service, scope, params, "after", LINES_BYTES, signal);
  if (file.state !== "ok") return { lines: [], total: null };
  // Binary content has no lines to show (same heuristic as Git: a NUL in the first 8 KB).
  if (file.bytes.subarray(0, 8000).includes(0)) return { lines: [], total: null };
  const lines = file.bytes.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return {
    lines: lines.slice(params.from - 1, params.from - 1 + params.count),
    total: lines.length,
  };
}

const formats: [(b: Buffer) => boolean, string, string][] = [
  [(b) => b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")), "png", "image/png"],
  [(b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, "jpg", "image/jpeg"],
  [(b) => /^GIF8[79]a/.test(b.subarray(0, 6).toString("latin1")), "gif", "image/gif"],
  [
    (b) =>
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
    "webp",
    "image/webp",
  ],
  [(b) => b.subarray(0, 2).toString("latin1") === "BM", "bmp", "image/bmp"],
  [(b) => b.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])), "ico", "image/x-icon"],
  [(b) => ["II*\0", "MM\0*"].includes(b.subarray(0, 4).toString("latin1")), "tiff", "image/tiff"],
  [
    (b) => b.subarray(4, 8).toString("latin1") === "ftyp" && /^avi[fs]/.test(brand(b)),
    "avif",
    "image/avif",
  ],
  [
    (b) =>
      b.subarray(4, 8).toString("latin1") === "ftyp" &&
      /^(hei[cx]|hev[cx]|mif1|msf1)/.test(brand(b)),
    "heic",
    "image/heic",
  ],
];
function brand(bytes: Buffer) {
  return bytes.subarray(8, 12).toString("latin1");
}
/** The type comes from the bytes, never the file name: a renamed file is not trusted. */
function sniff(bytes: Buffer) {
  for (const [test, ext, mime] of formats) if (test(bytes)) return { ext, mime };
  return undefined;
}

export async function changesImage(
  service: ChangesService,
  params: MethodParams["changes.image"],
  signal: AbortSignal,
): Promise<ChangesImageSide> {
  const scope = await service.scope(params, signal);
  const file = await content(service, scope, params, params.side, IMAGE_BYTES, signal);
  if (file.state === "missing") return file;
  if (file.state === "too_large") return { state: "too_large", bytes: file.size };
  const type = sniff(file.bytes);
  if (!type) return { state: "unsupported" };
  const size = imageDimensions(file.bytes, type.mime);
  const meta = {
    mimeType: type.mime,
    bytes: file.bytes.length,
    width: size?.width ?? null,
    height: size?.height ?? null,
  };
  const host = service.local.deps.host.attachments?.changeThumbnail;
  if (!host) {
    // A host without an image toolkit (server brain) can still show small PNG / JPEG originals.
    if (file.bytes.length > THUMBNAIL_BYTES || !["image/png", "image/jpeg"].includes(type.mime))
      return { state: "unsupported" };
    return {
      state: "ok",
      ...meta,
      thumbnail: {
        type: "image",
        data: file.bytes.toString("base64"),
        mimeType: type.mime as "image/png",
      },
    };
  }
  // The host thumbnails files it can verify are brain-owned; stage the bytes there briefly.
  const dir = join(service.local.deps.dataDir, "bots", scope.botId, "changes", "previews");
  const name = `${randomUUID()}.${type.ext}`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, name), file.bytes, { mode: 0o600, flag: "wx" });
  try {
    const thumbnail = await host({ botId: scope.botId, file: name }, signal);
    return { state: "ok", ...meta, thumbnail };
  } catch (error) {
    signal.throwIfAborted();
    // Formats the platform cannot decode (e.g. HEIC on Linux) are "no preview", not a failure.
    if (
      error instanceof RpcError &&
      (error.code === RpcErrorCodes.attachmentConversion ||
        error.code === RpcErrorCodes.attachmentInvalid)
    )
      return { state: "unsupported" };
    throw error;
  } finally {
    await rm(join(dir, name), { force: true });
  }
}
