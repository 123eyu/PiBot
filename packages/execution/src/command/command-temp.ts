import { lstat, mkdir, mkdtemp, readdir, realpath, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

const RUN_PREFIX = "pibot-run-";
const JOB_PREFIX = "pibot-job-";
/** Callers that never release (one-off Git writes) cannot grow this without bound. */
const LIVE_RUNS = 64;
/** A crashed brain leaves its folders; turns end within hours, background jobs may run for days. */
const STALE_RUN_MS = 24 * 60 * 60 * 1000;
const STALE_JOB_MS = 7 * 24 * 60 * 60 * 1000;
/** bash 3.2 (macOS /bin/bash) names its here-document files like this. */
const HEREDOC = /^sh-thd-\d+$/;

/**
 * Private temp folders for commands. SRT hands every sandboxed command TMPDIR=/tmp/claude, a folder
 * shared by all commands that nothing recreates after a reboot; tools that find TMPDIR unusable
 * fall back to /tmp (not writable in the sandbox) and then to the working folder, so their temp
 * files land in the user's project. Each run instead gets its own folder under the brain's temp
 * root; only this private folder is granted to the command. It lives for the whole run because a
 * Bot may create a temp path in one command and use it in the next, and is removed when the run ends.
 */
export function createCommandTemps(tempRoot: string) {
  const runs = new Map<string, Promise<string>>();
  const pins = new Map<string, number>();
  let swept = false;
  const root = () => realpath(tempRoot);
  async function sweep() {
    const base = await root();
    const now = Date.now();
    for (const name of await readdir(base).catch(() => [] as string[])) {
      const limit = name.startsWith(RUN_PREFIX)
        ? STALE_RUN_MS
        : name.startsWith(JOB_PREFIX)
          ? STALE_JOB_MS
          : undefined;
      if (!limit) continue;
      const info = await lstat(join(base, name)).catch(() => undefined);
      if (info?.isDirectory() && now - info.mtimeMs > limit) await remove(join(base, name));
    }
  }
  async function create(prefix: string) {
    if (!swept) {
      swept = true;
      void sweep().catch(() => {
        // Stale folders only cost disk space; the OS temp cleaner removes them eventually.
      });
    }
    const directory = await mkdtemp(join(await root(), prefix));
    try {
      const state = join(directory, "tool-state");
      await mkdir(state, { mode: 0o700 });
      await mkdir(join(state, "runtime"), { mode: 0o700 });
      return directory;
    } catch (error) {
      await remove(directory);
      throw error;
    }
  }
  async function remove(dir: string) {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      // Windows refuses while a process that outlived its command still holds a file; the stale
      // sweep of a later brain removes the folder.
    });
  }
  return {
    pin(runId: string) {
      pins.set(runId, (pins.get(runId) ?? 0) + 1);
    },
    unpin(runId: string) {
      const count = (pins.get(runId) ?? 1) - 1;
      if (count) pins.set(runId, count);
      else pins.delete(runId);
    },
    /** The run's folder, created on its first command. */
    forRun(runId: string): Promise<string> {
      let dir = runs.get(runId);
      if (dir) runs.delete(runId);
      else {
        dir = create(RUN_PREFIX);
        // A failed mkdtemp must not stick: the next command of the run tries again.
        dir.catch(() => runs.delete(runId));
      }
      runs.set(runId, dir);
      for (const [oldest, folder] of runs) {
        if (runs.size <= LIVE_RUNS) break;
        if (pins.has(oldest)) continue;
        runs.delete(oldest);
        void folder.then(remove, () => undefined);
      }
      return dir;
    },
    releaseRun(runId: string) {
      if (pins.has(runId)) throw new Error("command_temp_in_use");
      const dir = runs.get(runId);
      runs.delete(runId);
      return dir?.then(remove, () => undefined) ?? Promise.resolve();
    },
    /** A background job outlives its run, so it has its own folder, removed when it ends. */
    forJob: () => create(JOB_PREFIX),
    remove,
    async dispose() {
      const dirs = [...runs.values()];
      runs.clear();
      await Promise.all(dirs.map((dir) => dir.then(remove, () => undefined)));
    },
  };
}

/**
 * macOS /bin/bash (3.2) ignores TMPDIR for here-documents: it tries /var/tmp, /tmp, /usr/tmp and
 * then the current folder, and only the last is writable in the sandbox. bash removes the file
 * right after opening it, so a leftover appears only when the command is killed while bash is
 * still writing the document (a slow `$(...)` inside it). Only files created during this command
 * are removed, and only after a kill: a normal exit never leaves one, and a background job in the
 * same folder may be between creating and removing its own.
 */
export async function removeHeredocLeftovers(cwd: string, since: number) {
  for (const name of await readdir(cwd).catch(() => [] as string[])) {
    if (!HEREDOC.test(name)) continue;
    const path = join(cwd, name);
    const info = await lstat(path).catch(() => undefined);
    if (info?.isFile() && info.birthtimeMs >= since)
      await unlink(path).catch(() => {
        // Already gone, or the folder became read-only; nothing else depends on this cleanup.
      });
  }
}
