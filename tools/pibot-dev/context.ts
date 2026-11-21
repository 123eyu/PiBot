import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type StepRecord, stateStore, type TaskRecord } from "./state.ts";

// core.quotepath off: file names with non-ASCII characters
// otherwise come back quoted and escaped, and every path read on them failed with ENOENT.
export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "core.quotepath=off", ...args], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
  }).trim();
/** The main working tree, wherever this runs from (state lives there, like tools/codex). */
export const repo = resolve(
  dirname(git(process.cwd(), "rev-parse", "--path-format=absolute", "--git-common-dir")),
);
export const store = stateStore(join(repo, ".pibot-dev"));
export const now = () => new Date().toISOString();

/**
 * The workspace's storeDir is relative, so pnpm in a task worktree would download a 5 GB store of
 * its own (and verify's install stage would find node_modules linked to another store). Every pnpm
 * this script runs in a worktree shares the main tree's store instead (same disk: hard links).
 */
export const pnpmEnv = {
  ...process.env,
  pnpm_config_store_dir: join(repo, ".pnpm-store"),
  pnpm_config_cache_dir: join(repo, ".cache", "pnpm"),
};

export function argValue(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function taskOf(raw: string | undefined, usage: string): TaskRecord {
  const task = raw ? store.read().tasks[raw.toLowerCase()] : undefined;
  if (!task) throw new Error(raw ? `unknown task ${raw}` : `usage: ${usage}`);
  return task;
}

export function setStatus(id: string, status: TaskRecord["status"]) {
  store.update((state) => {
    const task = state.tasks[id];
    if (task) task.status = status;
  });
}

export function record(id: string, step: StepRecord, patch: Partial<TaskRecord> = {}) {
  store.update((state) => {
    const task = state.tasks[id];
    if (!task) throw new Error(`unknown task ${id}`);
    task.steps.push(step);
    Object.assign(task, patch);
  });
}

/**
 * Runs one fixed sandbox-outside command with its output in a log file (verify prints tens of
 * thousands of lines). Arguments are always literals from this script, never model output.
 */
export function runLogged(
  id: string,
  name: string,
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
) {
  const log = join(store.dir, "logs", `${id}-${name}-${Date.now()}.log`);
  mkdirSync(dirname(log), { recursive: true });
  const fd = openSync(log, "w");
  const started = Date.now();
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", fd, fd],
      timeout: options.timeoutMs,
    });
  } finally {
    closeSync(fd);
  }
  return {
    ok: result.status === 0,
    code: result.status,
    signal: result.signal,
    // Keep only the operating-system code, never spawn's message or command arguments.
    errorCode: result.error && "code" in result.error ? String(result.error.code) : undefined,
    timedOut:
      result.error !== undefined && "code" in result.error && result.error.code === "ETIMEDOUT",
    log,
    durationMs: Date.now() - started,
    text: () => readFileSync(log, "utf8"),
  };
}
