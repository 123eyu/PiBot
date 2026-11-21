import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileIdentity, matchesFileIdentity, sameFile } from "../core/file-identity.ts";
import { ExecError } from "../core/types.ts";
import { checkedDirectory, skippableError, walkFiles } from "../files/search-walk.ts";
import { verifyWorkspace } from "../sandbox/workspace.ts";
import type {
  SemanticFile,
  SemanticFileCacheEntry,
  SemanticSnapshot,
  SourceAccess,
} from "./types.ts";

/** The reader's own cap; a file above it is refused before it is opened, and callers report it. */
export const MAX_SOURCE_BYTES = 1024 * 1024;
export const semanticHash = (value: string) => createHash("sha256").update(value).digest("hex");
export function snapshotHash(files: SemanticFile[]) {
  return semanticHash(
    JSON.stringify(
      [...files].sort((a, b) => a.path.localeCompare(b.path)).map(({ path, hash }) => [path, hash]),
    ),
  );
}
/** A cached entry is current only for the same inode, size and timestamps. */
const cacheMatches = (entry: SemanticFileCacheEntry, info: BigIntStats) =>
  entry.device === info.dev &&
  entry.inode === info.ino &&
  entry.size === info.size &&
  entry.mtimeNs === info.mtimeNs &&
  entry.ctimeNs === info.ctimeNs;

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".d.ts",
  ".d.mts",
  ".d.cts",
  ".json",
];

/**
 * A target's relative imports name files that usually matter more than whichever files
 * traversal reaches first. Only project-relative specifiers are resolved; package names and
 * tsconfig path aliases stay outside this bounded snapshot (the result is partial either way).
 */
function resolveDependency(from: string, specifier: string, known: ReadonlySet<string>) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return;
  const base = resolve(dirname(from), specifier);
  // `./x.js` in TypeScript usually means `x.ts`; strip a source/declaration suffix before probing.
  const stem = base.replace(/\.(?:d\.)?(?:[cm]?[jt]sx?)$/, "");
  for (const candidate of [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${stem}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => join(stem, `index${extension}`)),
  ])
    if (known.has(candidate)) return candidate;
}

/** Only the first 256 KiB can influence which files are read before the walk fills the rest. */
const IMPORT_SCAN_LIMIT = 256 * 1024;
/**
 * Imports only decide the order of the bounded snapshot, so a false positive costs one
 * extra candidate and cannot change correctness. A regex scan keeps the TypeScript compiler out
 * of the brain main thread, where every navigation and post-edit diagnostic would otherwise load
 * ~9 MB of compiler code and block the shared event loop.
 */
const RELATIVE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)(["'])(\.{1,2}\/[^"'\n\r]*)\1/g;

function importsOf(text: string, focusedReasons?: Set<string>) {
  // A bounded prefix cannot certify that later local imports stayed unresolved/unchanged.
  if (text.length > IMPORT_SCAN_LIMIT) focusedReasons?.add("focused_import_scan_limit");
  const head = text.length > IMPORT_SCAN_LIMIT ? text.slice(0, IMPORT_SCAN_LIMIT) : text;
  const specifiers: string[] = [];
  for (const match of head.matchAll(RELATIVE_IMPORT)) {
    const specifier = match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}
/**
 * Why a path was refused. `undefined` alone left callers unable to name the cause, so a
 * 2 MiB file, a binary file and a denied file all reached the model as `unsupported_language`.
 */
export type SourceRefusal =
  | "outside_root"
  | "denied"
  | "file_too_large"
  | "not_utf8"
  | "not_a_file"
  | "changed";

/** Each actual path is authorized before bytes are opened, including configuration data. */
export async function readSource(
  access: SourceAccess,
  path: string,
  /** Optional: report the refusal cause instead of leaving the caller with a bare `undefined`. */
  onRefusal?: (reason: SourceRefusal) => void,
): Promise<SemanticFile | undefined> {
  const refuse = (reason: SourceRefusal): undefined => {
    onRefusal?.(reason);
    return undefined;
  };
  const { signal } = access;
  access.assertCurrent(signal);
  const name = relative(access.root, path);
  if (!name || name === ".." || name.startsWith(`..${sep}`) || resolve(access.root, name) !== path)
    return refuse("outside_root");
  let ancestor = dirname(path);
  while (true) {
    if (!(await access.authorize(ancestor, "directory", signal))) return refuse("denied");
    await checkedDirectory(ancestor, signal);
    if (ancestor === access.root) break;
    const parent = dirname(ancestor);
    if (parent === ancestor) return refuse("outside_root");
    ancestor = parent;
  }
  if (!(await access.authorize(path, "file", signal))) return refuse("denied");
  await verifyWorkspace(access.rootIdentities, signal);
  const before = await lstat(path, { bigint: true });
  // Size first: an over-limit file is never opened, so this is both the cheapest check and the
  // only place that can still tell the caller the file was too large rather than unreadable.
  if (before.size > BigInt(MAX_SOURCE_BYTES)) return refuse("file_too_large");
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink > 1n ||
    (await realpath(path)) !== path
  )
    return refuse("not_a_file");
  const cached = access.cache?.files.get(path);
  if (cached && cacheMatches(cached, before)) {
    await checkedDirectory(dirname(path), signal);
    const current = await lstat(path, { bigint: true });
    if (
      sameFile(current, before) &&
      current.size === before.size &&
      current.mtimeNs === before.mtimeNs &&
      current.ctimeNs === before.ctimeNs &&
      (await realpath(path)) === path
    ) {
      await verifyWorkspace(access.rootIdentities, signal);
      access.assertCurrent(signal);
      if (!(await access.authorize(path, "file", signal))) return refuse("denied");
      return { path: name.split(sep).join("/"), text: cached.text, hash: cached.hash };
    }
    access.cache?.files.delete(path);
    if (access.cache)
      access.cache.bytes = Math.max(0, (access.cache.bytes ?? 0) - Number(cached.size));
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat({ bigint: true });
    if (info.size > BigInt(MAX_SOURCE_BYTES)) return refuse("file_too_large");
    if (!info.isFile() || info.nlink > 1n || !sameFile(info, before)) return refuse("not_a_file");
    const bytes = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > MAX_SOURCE_BYTES) return refuse("file_too_large");
    const after = await file.stat({ bigint: true });
    if (
      after.size !== info.size ||
      after.mtimeNs !== info.mtimeNs ||
      after.ctimeNs !== info.ctimeNs
    )
      return refuse("changed");
    await checkedDirectory(dirname(path), signal);
    const current = await lstat(path, { bigint: true });
    if (!sameFile(current, info) || (await realpath(path)) !== path) return refuse("changed");
    await verifyWorkspace(access.rootIdentities, signal);
    access.assertCurrent(signal);
    if (!(await access.authorize(path, "file", signal))) return refuse("denied");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    } catch {
      return refuse("not_utf8");
    }
    if (text.includes("\0")) return refuse("not_utf8");
    const hash = semanticHash(text);
    if (access.cache) {
      const cache = access.cache;
      cache.bytes ??= 0;
      // Changed files leave old entries behind; keep the run's retained text bounded.
      if (cache.files.size >= 2048 || cache.bytes + Number(info.size) > 32 * 1024 * 1024) {
        cache.files.clear();
        cache.bytes = 0;
      }
      cache.files.set(path, {
        device: info.dev,
        inode: info.ino,
        size: info.size,
        mtimeNs: info.mtimeNs,
        ctimeNs: info.ctimeNs,
        text,
        hash,
      });
      cache.bytes += Number(info.size);
    }
    return { path: name.split(sep).join("/"), text, hash };
  } finally {
    await file.close();
  }
}

export async function captureProject(
  access: SourceAccess,
  allText = false,
  preferredPaths: readonly string[] = [],
  /**
   * Walk only this directory (the tsconfig's own project) instead of the whole workplace.
   * An edit inside `packages/x` was scanning every file under the workplace and paying a policy
   * decision for each one, which made one-line edits wait seconds for diagnostics. The snapshot
   * root and every `file.path` stay relative to `access.root`.
   */
  scanRoot?: string,
  focused = false,
  /** Optional local version receipt; absent candidates never travel to the compiler worker. */
  focusedVersions?: Map<string, string>,
): Promise<SemanticSnapshot> {
  await verifyWorkspace(access.rootIdentities, access.signal);
  if (!(await access.authorize(access.root, "directory", access.signal)))
    throw new Error("project_unavailable");
  const root = await checkedDirectory(access.root, access.signal);
  const files: SemanticFile[] = [],
    reasons = new Set<string>();
  const captured = new Map<string, SemanticFile>();
  let bytes = 0;
  const included = new Set<string>();
  const limit = focused ? 128 : allText ? 500 : 512;
  const excluded = (name: string) =>
    /(^|\/)(?:\.git|node_modules|\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials)(?:\/|$)/.test(
      name,
    );
  const eligible = (name: string) =>
    !excluded(name) && (allText || /\.(?:[cm]?[jt]sx?|json)$/.test(name));
  const capture = async (path: string) => {
    // walkFiles names entries relative to the walk root; the snapshot always speaks access.root.
    const name = relative(access.root, path).split(sep).join("/");
    if (included.has(name) || !eligible(name)) return;
    if (files.length >= limit) return "scan_limit";
    try {
      const file = await readSource(access, path);
      if (!file) {
        reasons.add("denied_or_unavailable");
        return;
      }
      const size = Buffer.byteLength(file.text);
      if (bytes + size > 16 * 1024 * 1024) return "byte_limit";
      bytes += size;
      included.add(file.path);
      captured.set(path, file);
      files.push(file);
    } catch (error) {
      access.signal.throwIfAborted();
      if (!skippableError(error)) throw error;
      reasons.add("denied_or_unavailable");
    }
    return;
  };
  // Only an existing directory inside the snapshot root may narrow the walk.
  const scoped = scanRoot ? relative(access.root, scanRoot) : "..";
  const walkRoot =
    scoped && scoped !== ".." && !scoped.startsWith(`..${sep}`) && !isAbsolute(scoped)
      ? await checkedDirectory(scanRoot as string, access.signal)
      : root;
  const preferred = [...new Set(preferredPaths)].sort().slice(0, 200);
  /**
   * Whole-project navigation with a target collects names first (directories still
   * authorize), then reads the target, expands its relative import/export specifiers
   * breadth-first, and fills the rest in walk order. `allText` captures (review snapshots) and
   * scoped diagnostics keep the streaming walk: review needs every target to fit anyway, and
   * diagnostics already narrowed the walk, so a second pass would only add latency.
   */
  if (focused && !allText && preferred.length) {
    const queue = preferred.map((name) => resolve(access.root, name));
    const visited = new Set<string>();
    let index = 0;
    focusedScan: while (index < queue.length && files.length < limit) {
      access.signal.throwIfAborted();
      const path = queue[index++] as string;
      if (visited.has(path)) continue;
      visited.add(path);
      const stop = await capture(path);
      if (stop) {
        reasons.add(stop);
        break;
      }
      const source = captured.get(path);
      if (!source) continue;
      for (const specifier of new Set(importsOf(source.text, reasons))) {
        const base = resolve(dirname(path), specifier);
        const stem = base.replace(/\.(?:d\.)?(?:[cm]?[jt]sx?)$/, "");
        for (const candidate of [
          base,
          ...SOURCE_EXTENSIONS.map((extension) => `${stem}${extension}`),
          ...SOURCE_EXTENSIONS.map((extension) => join(stem, `index${extension}`)),
        ]) {
          const name = relative(access.root, candidate).split(sep).join("/");
          if (
            !name ||
            name === ".." ||
            name.startsWith("../") ||
            isAbsolute(name) ||
            !eligible(name)
          )
            continue;
          if (focusedVersions?.get(name) === "missing") continue;
          if (focusedVersions && !focusedVersions.has(name) && focusedVersions.size >= 512) {
            reasons.add("focused_dependency_limit");
            break focusedScan;
          }
          const limited = visited.has(candidate) ? undefined : await capture(candidate);
          if (limited) {
            reasons.add(limited);
            break;
          }
          const dependency = captured.get(candidate);
          focusedVersions?.set(name, dependency?.hash ?? "missing");
          if (dependency) {
            if (!visited.has(candidate)) queue.push(candidate);
            break;
          }
        }
      }
    }
    reasons.add("focused_import_snapshot");
    if (index < queue.length) reasons.add("scan_limit");
  } else if (!allText && !scanRoot && preferred.length) {
    const candidates: string[] = [],
      known = new Set<string>();
    const collect = async (path: string): Promise<undefined> => {
      const name = relative(access.root, path).split(sep).join("/");
      if (known.has(name) || !eligible(name)) return undefined;
      known.add(name);
      candidates.push(path);
      return undefined;
    };
    const walked = await walkFiles(
      walkRoot,
      { cwd: access.root, writeRoots: [], signal: access.signal, authorizePath: access.authorize },
      collect,
    );
    if (walked.truncated) reasons.add(walked.truncated);
    if (walked.skippedUnreadable) reasons.add("denied_or_unavailable");
    const paths = new Set(candidates),
      queue: string[] = [],
      queued = new Set<string>();
    const enqueue = (path: string) => {
      if (queued.has(path)) return;
      queued.add(path);
      queue.push(path);
    };
    for (const name of preferred) enqueue(resolve(access.root, name));
    let expanded = false,
      cut = false;
    while (queue.length && files.length < limit) {
      access.signal.throwIfAborted();
      const path = queue.shift() as string;
      const stop = await capture(path);
      if (stop) {
        reasons.add(stop);
        cut = true;
        break;
      }
      const file = captured.get(path);
      if (!file) continue;
      for (const specifier of importsOf(file.text)) {
        const dependency = resolveDependency(path, specifier, paths);
        if (!dependency) continue;
        expanded = true;
        enqueue(dependency);
      }
    }
    // Walk order stays the deterministic fill, so two captures of one tree agree.
    for (const path of candidates) {
      const stop = await capture(path);
      if (stop) {
        reasons.add(stop);
        cut = true;
        break;
      }
    }
    // Only a limit that actually cut the snapshot makes the selection policy observable.
    if (expanded && cut) reasons.add("import_chain_selected");
  } else {
    // Changes are the review's subject, not whichever files happen to be visited first.
    for (const name of preferred) {
      access.signal.throwIfAborted();
      const stop = await capture(resolve(access.root, name));
      if (stop) reasons.add(stop);
    }
    const result = await walkFiles(
      walkRoot,
      { cwd: access.root, writeRoots: [], signal: access.signal, authorizePath: access.authorize },
      capture,
    );
    if (result.truncated) reasons.add(result.truncated);
    if (result.skippedUnreadable) reasons.add("denied_or_unavailable");
  }
  // Implicit traversal deliberately skips links, build trees and package stores. Never call it complete.
  reasons.add("bounded_project_scan");
  access.assertCurrent(access.signal);
  await verifyWorkspace(access.rootIdentities, access.signal);
  await checkedDirectory(root.path, access.signal, root.info);
  return {
    root: access.root,
    authorization: access.authorization,
    identity: fileIdentity(root.info),
    files,
    hash: snapshotHash(files),
    reasons: [...reasons],
  };
}
export async function verifySnapshotRoot(snapshot: SemanticSnapshot, access: SourceAccess) {
  access.assertCurrent(access.signal);
  if (snapshot.authorization !== access.authorization) throw new ExecError("outside_workplace");
  if (!(await access.authorize(snapshot.root, "directory", access.signal)))
    throw new Error("project_unavailable");
  const root = await checkedDirectory(snapshot.root, access.signal);
  if (!matchesFileIdentity(root.info, snapshot.identity)) throw new ExecError("outside_workplace");
  await verifyWorkspace(access.rootIdentities, access.signal);
}
