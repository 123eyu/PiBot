import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import { z } from "zod";
import { unzipInto } from "./bundled-git-unzip.ts";

/**
 * Windows builds ship MinGit as one verified zip (resources/bin/mingit), not as an unpacked tree:
 * the ~190 executables and DLLs of the tree made the installer write and Defender scan each one,
 * which took a Windows install from 47 s to 108–143 s. The zip is unpacked once, on first need,
 * into Pi Bot's own per-user cache: %LOCALAPPDATA%\Pi Bot\runtimes\mingit\<version>-<digest>.
 * Local, not the roaming data folder, so ~100 MB of binaries never travel with a roaming profile;
 * and keyed by digest, so every installed version and data folder shares one copy.
 */
const MANIFEST = z.strictObject({
  release: z.string().regex(/^v\d+\.\d+\.\d+\.windows\.\d+$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  archive: z.string().regex(/^MinGit-[\w.-]+\.zip$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z
    .number()
    .int()
    .positive()
    .max(200 * 1024 * 1024),
});
type Manifest = z.infer<typeof MANIFEST>;
const MARKER = ".pibot-mingit.json";
// Long enough for a loaded VM with Defender scanning every write; a lock older than this is dead.
const EXTRACT_DEADLINE_MS = 5 * 60_000;
const STALE_LOCK_MS = 10 * 60_000;
// A damaged archive fails the same way every time; do not re-read 40 MB for each Git call.
const FAILURE_BACKOFF_MS = 10 * 60_000;

export interface BundledGit {
  manifest: Manifest;
  archive: string;
  /** The unpacked MinGit root; `cmd\git.exe` is the program. */
  home: string;
  program: string;
}

const env = (values: Readonly<NodeJS.ProcessEnv>, name: string) =>
  Object.entries(values).find(([key]) => key.toUpperCase() === name)?.[1];
const plainPath = (path: string | undefined): path is string =>
  !!path && win32.isAbsolute(path) && !/[\0\r\n;%"]/.test(path);

/** The bundled MinGit of a packaged Windows build, or undefined (dev run, other platforms). */
export function bundledGit(
  platform: NodeJS.Platform,
  values: Readonly<NodeJS.ProcessEnv>,
  resourcesDir: string | undefined,
): BundledGit | undefined {
  const local = env(values, "LOCALAPPDATA");
  if (platform !== "win32" || !plainPath(resourcesDir) || !plainPath(local)) return undefined;
  const folder = win32.join(resourcesDir, "bin", "mingit");
  let manifest: Manifest;
  try {
    manifest = MANIFEST.parse(JSON.parse(readFileSync(win32.join(folder, "mingit.json"), "utf8")));
  } catch {
    // No manifest is a dev run or a build without MinGit; a malformed one is treated the same,
    // so Git falls back to git_unavailable instead of running something unverified.
    return undefined;
  }
  const home = win32.join(
    local,
    "Pi Bot",
    "runtimes",
    "mingit",
    `${manifest.version}-${manifest.sha256.slice(0, 12)}`,
  );
  return {
    manifest,
    archive: win32.join(folder, manifest.archive),
    home,
    program: win32.join(home, "cmd", "git.exe"),
  };
}

/** Whether the copy is fully unpacked; the marker is the last thing written before the rename. */
export function bundledGitReady(git: BundledGit) {
  try {
    return statSync(win32.join(git.home, MARKER)).isFile();
  } catch {
    // Not unpacked yet; the first Git need unpacks it.
    return false;
  }
}

/**
 * Unpacks the bundled MinGit if needed and returns its git.exe. Serialized across concurrent
 * callers and processes (two instances with separate data folders share the cache) by an
 * exclusive lock file; the copy is built in a private temporary folder and renamed into place, so
 * a crash or a power cut never leaves a half-unpacked Git that looks complete.
 */
export async function prepareBundledGit(
  git: BundledGit,
  onEvent?: (
    event: "unpack_started" | "unpack_finished" | "old_copy_removed" | "old_copy_remove_failed",
  ) => void,
): Promise<string> {
  const signal = AbortSignal.timeout(EXTRACT_DEADLINE_MS);
  const parent = win32.dirname(git.home);
  const name = win32.basename(git.home);
  const lock = win32.join(parent, `${name}.lock`);
  const failed = win32.join(parent, `${name}.failed`);
  await mkdir(parent, { recursive: true });
  for (;;) {
    if (bundledGitReady(git)) return git.program;
    await recentFailure(failed);
    const handle = await open(lock, "wx").catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      await breakStaleLock(lock);
      return undefined;
    });
    if (!handle) {
      // Another caller is unpacking; wait for its marker (or its failure) instead of racing it.
      await pause(250, signal);
      continue;
    }
    try {
      await handle
        .writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
        .finally(() => handle.close());
      if (bundledGitReady(git)) return git.program;
      onEvent?.("unpack_started");
      await extract(git, parent, name, signal, onEvent).catch(async (error) => {
        await writeFile(failed, JSON.stringify({ at: Date.now() })).catch(() => {
          // Without the record the next need simply tries again; the failure itself is reported.
        });
        throw error;
      });
      onEvent?.("unpack_finished");
      return git.program;
    } finally {
      await rm(lock, { force: true });
    }
  }
}

async function extract(
  git: BundledGit,
  parent: string,
  name: string,
  signal: AbortSignal,
  onEvent?: (
    event: "unpack_started" | "unpack_finished" | "old_copy_removed" | "old_copy_remove_failed",
  ) => void,
) {
  // Leftovers of an unpack that was killed: this lock holder is the only writer for this name.
  for (const entry of await readdir(parent))
    if (entry.startsWith(`${name}.tmp-`))
      await rm(win32.join(parent, entry), { recursive: true, force: true });
  const archive = await readFile(git.archive, { signal });
  const digest = createHash("sha256").update(archive).digest("hex");
  if (archive.length !== git.manifest.size || digest !== git.manifest.sha256)
    throw new Error("bundled_git_checksum_mismatch");
  const temporary = win32.join(parent, `${name}.tmp-${randomBytes(6).toString("hex")}`);
  try {
    await mkdir(temporary);
    await unzipInto(archive, temporary, signal);
    await stat(win32.join(temporary, "cmd", "git.exe"));
    await writeFile(
      win32.join(temporary, MARKER),
      JSON.stringify({ release: git.manifest.release, sha256: git.manifest.sha256 }),
    );
    // A folder without the marker is an older partial copy (or one a person emptied); replace it.
    await rm(git.home, { recursive: true, force: true });
    await renameWithRetry(temporary, git.home, signal);
    await removeOldCopies(parent, name, onEvent);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Defender and the indexer briefly hold fresh executables open, which fails a folder rename. */
async function renameWithRetry(from: string, to: string, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 40 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      await pause(250, signal);
    }
  }
}

async function recentFailure(path: string) {
  try {
    if (Date.now() - (await stat(path)).mtimeMs < FAILURE_BACKOFF_MS)
      throw new Error("bundled_git_unpack_failed_recently");
    await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function breakStaleLock(path: string) {
  try {
    const { pid, at } = z
      .object({ pid: z.number().int(), at: z.number() })
      .parse(JSON.parse(await readFile(path, "utf8")));
    if (Date.now() - at < STALE_LOCK_MS && alive(pid)) return;
  } catch (error) {
    // A lock being written right now has no content yet; only an old unreadable one is stale.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    const age = await stat(path).then(
      (info) => Date.now() - info.mtimeMs,
      () => 0,
    );
    if (age < 5_000) return;
  }
  await rm(path, { force: true });
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else, so the lock is still held.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      if (signal.aborted) reject(signal.reason);
      else resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

async function removeOldCopies(
  parent: string,
  current: string,
  onEvent?: (
    event: "unpack_started" | "unpack_finished" | "old_copy_removed" | "old_copy_remove_failed",
  ) => void,
) {
  const entries = await readdir(parent, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name === current ||
      !/^\d+\.\d+\.\d+-[0-9a-f]{12}$/.test(entry.name)
    )
      continue;
    try {
      await rm(win32.join(parent, entry.name), { recursive: true, force: true });
      onEvent?.("old_copy_removed");
    } catch (error) {
      const code = error as NodeJS.ErrnoException;
      onEvent?.("old_copy_remove_failed");
      // The new copy is already installed. A running old Git may keep files locked on Windows.
      if (!code || !["EBUSY", "EPERM", "EACCES"].includes(code.code ?? "")) throw error;
    }
  }
}
