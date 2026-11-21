import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bundleProcesses, ownerActivity } from "./app-activity.ts";
import { builtMacArtifact } from "./app-artifact.ts";
import { inspectMacArtifactAsync } from "./app-artifact-async.ts";
import { installMacArtifact, unfinishedInstallReceipt } from "./app-install.ts";
import { runInstallCommand } from "./app-install-process.ts";
import { installedReady } from "./app-install-ready.ts";
import { repo, store } from "./context.ts";
import { packageMacAsync } from "./mac-package.ts";
import { testMacCopy } from "./mac-test.ts";
import type { TaskRecord } from "./state.ts";

/*
 * macOS only for now: the workflow host is the owner's Mac; Windows has test-win.
 */

const MIN = 60 * 1000;
const INSTALLED = "/Applications/Pi Bot.app";
export const ownerData = join(homedir(), "Library", "Application Support", "Pi Bot");

export function builtApp(worktree: string) {
  return builtMacArtifact(worktree)?.path;
}

/** The task lane owns cooperative cancellation; main installation retains its separate build. */
export async function packageMac(task: TaskRecord, signal: AbortSignal, runId?: string) {
  return packageMacAsync(task, signal, runId);
}

function stopPid(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("app_stop_failed");
  }
}

/** The private-copy runner owns its process/data/CDP identities and ordered cleanup. */
export function testMac(
  task: TaskRecord,
  flows: string[],
  port?: number,
  signal?: AbortSignal,
  runId?: string,
) {
  return testMacCopy(task, flows, port, signal, runId);
}

/** No elapsed-log heuristic can prove that a parked run stopped. */
export function activeRuns(_botId?: string) {
  // Preserve the synchronous string[] API. Unknown is deliberately nonempty so legacy callers
  // cannot mistake a live owner without a maintenance receipt for idle.
  return ownerActivity(INSTALLED, ownerData);
}

/** Replaces the owner's installed app with `source` while it is idle, then reopens it. */
export async function install(source: string, waitMs: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (process.platform !== "darwin") throw new Error("mac_install_unsupported");
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 24 * 60 * MIN)
    throw new Error("install_wait_invalid");
  const installLog = join(store.dir, "logs", "mac-install.jsonl");
  mkdirSync(join(store.dir, "logs"), { recursive: true });
  const lock = join(store.dir, "logs", "mac-install.lock");
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    throw new Error("install_locked_recovery_may_be_required");
  }
  try {
    if (
      existsSync(installLog) &&
      (!lstatSync(installLog).isFile() ||
        lstatSync(installLog).size > 1 << 20 ||
        unfinishedInstallReceipt(readFileSync(installLog, "utf8")))
    )
      throw new Error("install_previous_recovery_required");
    await installMacArtifact(
      source,
      INSTALLED,
      waitMs,
      {
        activity: () => activeRuns(),
        inspect: inspectMacArtifactAsync,
        exists: existsSync,
        copy: async (from, to, signal) => {
          await runInstallCommand("/usr/bin/ditto", [from, to], signal, 120_000);
        },
        rename: renameSync,
        remove: (path) => rmSync(path, { recursive: true, force: true }),
        processes: () => bundleProcesses(INSTALLED),
        stop: () => {
          for (const pid of bundleProcesses(INSTALLED)) stopPid(pid, "SIGTERM");
        },
        open: async (signal) => {
          await runInstallCommand("/usr/bin/open", ["-n", INSTALLED], signal, 15_000);
        },
        ready: async (artifact, since, signal) => {
          const deadline = Date.now() + 90_000;
          while (Date.now() < deadline) {
            signal.throwIfAborted();
            if (await installedReady(ownerData, artifact, since, bundleProcesses(INSTALLED))) {
              if ((await inspectMacArtifactAsync(INSTALLED, signal)).digest !== artifact.digest)
                throw new Error("install_running_artifact_changed");
              return true;
            }
            await delay(500, undefined, { signal });
          }
          return false;
        },
        sleep: (ms, signal) => delay(ms, undefined, { signal }),
        now: Date.now,
        receipt: (value) => {
          mkdirSync(join(store.dir, "logs"), { recursive: true });
          appendFileSync(
            installLog,
            `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`,
          );
        },
      },
      signal,
    );
  } finally {
    closeSync(fd);
    rmSync(lock);
  }
}

/** The main build shares the cancellable packager; installation starts only after it succeeds. */
export async function packageMain(signal: AbortSignal = new AbortController().signal) {
  return packageMacAsync({ id: "main", worktree: repo }, signal);
}
