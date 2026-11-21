import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { RpcError, RpcErrorCodes } from "@pibot/plugins-contract/full";
import { obsidianConfigs } from "./knowledge-detect.ts";

// The host half of "open the note this reply links". The brain has already proved the
// reply, the current assignment and the vault/note identities; this module proves the *name* in the
// rebuilt URI still points at exactly that vault, then rebuilds `obsidian://open` itself and hands
// only that string to the system. No href, command, app name or arbitrary path arrives here.

/** Obsidian's own list; anything bigger or unparsable cannot prove uniqueness, so it fails closed. */
const MAX_CONFIG_BYTES = 1024 * 1024;
/** A crafted list must not fan out: past this many entries the answer is "cannot prove it". */
const MAX_VAULTS = 200;
/** The host's slow read stays inside the brain's RPC budget even on a stalled network share. */
const OPEN_TIMEOUT_MS = 15_000;

export interface OpenKnowledgeNoteParams {
  requestId: string;
  sourceId: string;
  vault: { path: string; device: string; inode: string };
  note: { relativePath: string; device: string; inode: string };
}

/**
 * Re-checks what the brain verified, asks it once more (the click may have been revoked while the
 * configuration was read) and only then lets the system open the note.
 */
export async function openKnowledgeNote(options: {
  platform: NodeJS.Platform;
  home: string;
  env: (name: string) => string | undefined;
  params: OpenKnowledgeNoteParams;
  signal: AbortSignal;
  confirm(): Promise<void>;
  openExternal(url: string): Promise<void>;
}): Promise<{ opened: true }> {
  const deadline = AbortSignal.any([options.signal, AbortSignal.timeout(OPEN_TIMEOUT_MS)]);
  try {
    const first = await proveTarget(options, deadline);
    deadline.throwIfAborted();
    await options.confirm();
    deadline.throwIfAborted();
    // `confirm()` is asynchronous (brain RPC, IPC round trip) and the system open is still ahead:
    // the note, its folders or Obsidian's own mapping can change meanwhile, so the whole proof is
    // repeated and has to describe the same vault and note. The confirm callback must not be the
    // last moment anything was checked.
    const last = await proveTarget(options, deadline);
    if (last.vaultPath !== first.vaultPath || last.notePath !== first.notePath) throw changed();
    deadline.throwIfAborted();
    const file = last.notePath.slice(last.vaultPath.length + 1).replace(/\.md$/i, "");
    const url = `obsidian://open?vault=${encodeURIComponent(
      basename(last.vaultPath),
    )}&file=${encodeURIComponent(file)}`;
    // From here the URI may already have reached the system: a thrown error cannot prove the note
    // did not open, so it is reported as an unknown outcome and never retried on the person's
    // behalf (a second open would be a second side effect, not a retry).
    try {
      await options.openExternal(url);
    } catch {
      throw unknown();
    }
    return { opened: true };
  } catch (error) {
    if (error instanceof RpcError) throw error;
    // An aborted read is the person closing the app or giving up, not a broken configuration.
    if (deadline.aborted) throw new RpcError(RpcErrorCodes.internal, "knowledge_open_cancelled");
    throw unsupported();
  }
}

/** Everything that must be true of the target, checked again after the brain's confirmation. */
async function proveTarget(
  options: {
    platform: NodeJS.Platform;
    home: string;
    env: (name: string) => string | undefined;
    params: OpenKnowledgeNoteParams;
  },
  deadline: AbortSignal,
): Promise<{ vaultPath: string; notePath: string }> {
  const vaultPath = await canonicalVault(options.params.vault, deadline);
  // Obsidian resolves `vault` by folder name, so the name has to be unique among the vaults it
  // knows *and* resolve to this exact folder; two same-named vaults are never guessed between.
  const named = (await configuredVaults(options, deadline)).filter(
    (path) => basename(path) === basename(vaultPath),
  );
  if (named.length !== 1 || named[0] !== vaultPath) throw unsupported();
  const notePath = await noteInside(vaultPath, options.params.note, deadline);
  return { vaultPath, notePath };
}

/** The recorded folder must still be the same entity: same canonical path, same device and inode. */
async function canonicalVault(
  vault: { path: string; device: string; inode: string },
  deadline: AbortSignal,
): Promise<string> {
  let real: string;
  try {
    real = await bounded(realpath(vault.path), deadline);
  } catch {
    if (deadline.aborted) throw deadline.reason;
    throw changed();
  }
  if (real !== resolve(vault.path)) throw changed();
  const info = await stats(real, deadline);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev.toString() !== vault.device ||
    info.ino.toString() !== vault.inode
  )
    throw changed();
  return real;
}

/**
 * Every vault Obsidian itself lists. A missing configuration means Obsidian is not set up here (no
 * way to open a note); an oversized, unreadable or malformed one means we cannot prove which vault
 * the name means, and both are refused rather than worked around.
 */
async function configuredVaults(
  options: {
    platform: NodeJS.Platform;
    home: string;
    env: (name: string) => string | undefined;
  },
  deadline: AbortSignal,
): Promise<string[]> {
  const configs = obsidianConfigs(options.platform, options.home, options.env);
  const paths: string[] = [];
  const seen = new Set<string>();
  let found = false;
  let candidates = 0;
  for (const config of configs) {
    let text: string;
    try {
      const info = await bounded(lstat(config, { bigint: true }), deadline);
      const limit = BigInt(MAX_CONFIG_BYTES);
      if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw unsupported();
      found = true;
      // The size `lstat` saw can be stale by the time the bytes arrive, so the bytes actually read
      // are what the limit is applied to as well.
      const bytes = await bounded(readFile(config, { signal: deadline }), deadline);
      if (bytes.byteLength > MAX_CONFIG_BYTES) throw unsupported();
      text = bytes.toString("utf8");
    } catch (error) {
      if (deadline.aborted) throw deadline.reason;
      if (error instanceof RpcError) throw error;
      // A platform keeps its list in more than one place; only "this one is not here" is fine.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw unsupported();
    }
    const listed = vaultPaths(text);
    // Counted before dedup and before skipping invalid entries: a list padded with junk or repeats
    // must not be able to hide how many vaults it names.
    candidates += listed.length;
    if (candidates > MAX_VAULTS) throw unsupported();
    for (const path of listed) {
      const canonical = resolve(path);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      paths.push(canonical);
    }
  }
  if (!found) throw unsupported();
  return paths;
}

/**
 * Every entry has to be a complete mapping. Skipping the ones we do not understand would let a
 * truncated or hostile list pass as "these are all the vaults", which is exactly the uniqueness
 * question this function answers.
 */
function vaultPaths(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw unsupported();
  }
  const vaults = isRecord(parsed) ? parsed.vaults : undefined;
  if (!isRecord(vaults)) throw unsupported();
  const paths: string[] = [];
  for (const entry of Object.values(vaults)) {
    if (!isRecord(entry)) throw unsupported();
    const path = entry.path;
    // A relative path would be resolved against the host's cwd, which is not a folder anyone chose.
    if (
      typeof path !== "string" ||
      !path ||
      path.length > 32768 ||
      !isAbsolute(path) ||
      /[\p{Cc}\p{Cf}]/u.test(path)
    )
      throw unsupported();
    paths.push(path);
  }
  return paths;
}

/**
 * The note must resolve inside this vault, through no link, and still be the file the brain read:
 * the relative path is re-checked here because this is the last place before the system open.
 */
async function noteInside(
  vaultPath: string,
  note: { relativePath: string; device: string; inode: string },
  deadline: AbortSignal,
): Promise<string> {
  const parts = note.relativePath.split("/");
  if (
    parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".")) ||
    !/\.md$/i.test(note.relativePath)
  )
    throw invalid();
  const absolute = join(vaultPath, ...parts);
  // Every folder between the vault and the note has to be a real folder: a link standing in for a
  // folder would make this relative path name a file the brain never read.
  let current = vaultPath;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = await stats(current, deadline);
    if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
  }
  const info = await stats(absolute, deadline);
  if (!info.isFile() || info.isSymbolicLink()) throw invalid();
  // A hard link is the same bytes under a second name, so this path is not the only way to reach
  // them and cannot stand for "the note the reply showed".
  if (info.nlink !== 1n) throw invalid();
  if (info.dev.toString() !== note.device || info.ino.toString() !== note.inode) throw changed();
  let real: string;
  try {
    real = await bounded(realpath(absolute), deadline);
  } catch {
    if (deadline.aborted) throw deadline.reason;
    throw invalid();
  }
  // `realpath` resolves every link in the path, so a different answer means one of the checks above
  // missed a link component (a junction or a race); the URI must name this exact path.
  if (real !== absolute) throw invalid();
  return absolute;
}

async function stats(path: string, deadline: AbortSignal) {
  try {
    return await bounded(lstat(path, { bigint: true }), deadline);
  } catch {
    if (deadline.aborted) throw deadline.reason;
    throw changed();
  }
}

/**
 * `lstat` and `realpath` take no AbortSignal, and a stalled network volume can keep them waiting
 * past the click's own deadline. The underlying call is left to finish on its own; what matters is
 * that nothing is opened on behalf of a request that was already cancelled.
 */
function bounded<T>(pending: Promise<T>, deadline: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (deadline.aborted) {
      reject(deadline.reason);
      return;
    }
    const onAbort = () => reject(deadline.reason);
    deadline.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        deadline.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        deadline.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupported(): RpcError {
  return new RpcError(RpcErrorCodes.unsupported, "knowledge_reference_unsupported");
}

function invalid(): RpcError {
  return new RpcError(RpcErrorCodes.invalidParams, "knowledge_reference_invalid");
}

function changed(): RpcError {
  return new RpcError(RpcErrorCodes.invalidParams, "knowledge_reference_changed");
}

/** The system call was made; whether Obsidian opened the note is no longer knowable from here. */
function unknown(): RpcError {
  return new RpcError(RpcErrorCodes.internal, "knowledge_reference_unknown");
}
