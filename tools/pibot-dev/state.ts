import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireDirectoryLock } from "./operation-lock.ts";

/** One record per task; every step appends its outcome so `finish` can check prerequisites. */
export interface StepRecord {
  step:
    | "task"
    | "fix"
    | "test"
    /** Every 10 minutes an approval card stayed unanswered; retro counts how many. */
    | "approval_wait"
    | "verify"
    /** The workflow's own rerun of check:changed (not the Bot's). */
    | "check-changed"
    | "review"
    | "package"
    | "test-mac"
    | "test-win"
    | "finish";
  at: string;
  outcome: "ok" | "failed" | "skipped" | "task_failed" | "harness_failed";
  detail?: string;
  durationMs?: number;
  tools?: number;
  failedTools?: number;
  /** Token totals the app reported for this turn; absent when it reported none. */
  usage?: {
    requests?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  group?: import("../../packages/acp/src/types.ts").AcpGroupSnapshot;
  sessionId?: string;
  continued?: boolean;
  /** This turn ran in a new session because the previous one was out of context. */
  sessionReset?: boolean;
  /** The change set this result is about; a later change makes it stale (finish checks). */
  diffDigest?: string;
  artifact?: {
    path: string;
    platform: "darwin";
    arch: "arm64" | "x64";
    version: string;
    digest: string;
  };
  runId?: string;
  artifactHash?: string;
  stages?: import("./windows.ts").WindowsStageReceipt[];
  /** Where the full output is (verify, package, tests). */
  log?: string;
}
export interface TaskRecord {
  id: string;
  milestone: string;
  task: string;
  bot: string;
  branch: string;
  worktree: string;
  sessionId?: string;
  botId?: string;
  /** Versioned metadata only; old tasks need no migration. Never changes release gates. */
  retro?: import("./retro-types.ts").RetroSummary;
  target?: import("./group-target.ts").TaskTarget;
  group?: import("../../packages/acp/src/types.ts").AcpGroupSnapshot;
  /** Which of MODELS the Bot runs on for this task; "fallback" after the main one kept failing. */
  model?: "main" | "fallback";
  status:
    | "running"
    | "waiting_review"
    | "changes_requested"
    | "passed"
    | "testing"
    | "task_failed"
    | "harness_failed"
    | "sync_conflict"
    | "finished";
  steps: StepRecord[];
  /**
   * Unmerged files a sync left behind: the Bot resolves them with `pibot-dev resolve`,
   * which then drops the sync stash and clears the index entries. Present until then, so every
   * later sync refuses instead of stashing an index git cannot write.
   */
  syncConflict?: { files: string[]; stash?: string };
  /**
   * `pnpm check:changed` still failed on the work the Bot did after its own passing run.
   * Present until a check passes on the current content, so `status` and `review` show it instead
   * of letting verify be the first to notice.
   */
  checkFailure?: { at: string; detail: string; log?: string };
  reviewSnapshot?: { digest: string; baseOid: string; diffHash: string; diffFile: string };
  finishState?: {
    phase: "prepared" | "committed" | "merged" | "recorded" | "cleaned";
    digest: string;
    baseOid: string;
    startOid: string;
    treeOid: string;
    message: string;
    commitOid?: string;
    mainOid?: string;
  };
}
export interface State {
  tasks: Record<string, TaskRecord>;
  /**
   * Maintainers 2026-11-04: one topic per milestone. The ACP session of the milestone's latest task;
   * the next task loads it with its own worktree, so the Bot keeps what it already read.
   */
  milestones?: Record<string, { sessionId: string; lastTask: string; targetKey?: string }>;
  /** ACP sessions whose topics `tidy` already archived (bounded). */
  tidied?: string[];
}

export function stateStore(dir: string) {
  const file = join(dir, "state.json");
  const lock = join(dir, "state.lock");
  mkdirSync(dir, { recursive: true });
  const read = (): State => {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as State;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { tasks: {} };
      throw new Error("Workflow state is unreadable; refusing to replace it");
    }
  };
  /** mkdir is atomic: two pibot-dev runs never interleave their read-modify-write. */
  const update = <T>(change: (state: State) => T): T => {
    let release: (() => void) | undefined;
    for (let attempt = 0; !release; attempt++) {
      try {
        release = acquireDirectoryLock(lock);
      } catch (error) {
        if (attempt >= 200) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    try {
      const state = read();
      const result = change(state);
      writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
      return result;
    } finally {
      release();
    }
  };
  return { read, update, logPath: (id: string) => join(dir, "logs", `${id}.log`), dir };
}
