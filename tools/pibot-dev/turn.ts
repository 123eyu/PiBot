import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AcpDispatchIdentity,
  AcpHarnessError,
  runAcpTurn,
  TRANSIENT_RUN_FAILURES,
} from "./acp-client.ts";
import { followBackgroundTurn } from "./background.ts";
import { now, record, store } from "./context.ts";
import {
  assertRepairRecoverable,
  clearSettledRepair,
  markRepairDispatched,
  recordRepairGroup,
} from "./repair-marker.ts";
import type { StepRecord, TaskRecord } from "./state.ts";

/**
 * The owner's running app. Test copies are
 * launched with arguments (debug port, --pibot-background …), so only a bare executable counts.
 */
export function runningApp(): string {
  const listed = spawnSync("pgrep", ["-fl", "Pi Bot.app/Contents/MacOS/Pi Bot"], {
    encoding: "utf8",
  });
  for (const line of listed.stdout.split("\n")) {
    // An absolute path only: with several pibot-dev jobs at once, another job's own
    // `pgrep -fl …Pi Bot` line matched too and was spawned as the app (fixed 2026-11-05).
    const match = /^\d+ (\/.*Pi Bot\.app\/Contents\/MacOS\/Pi Bot)$/.exec(line.trim());
    if (match?.[1] && !match[1].includes("/PiBot-wt/")) return match[1];
  }
  throw new AcpHarnessError("app_not_running", "open Pi Bot first");
}

/**
 * Maintainers 2026-11-04: the dev Bot runs on a fast model; when a run keeps being cut off, retry
 * several times, then switch to a stronger fallback. Matched by provider display name and model id
 * against the models Pi Bot offers (ACP "model" option). PIBOT_DEV_MAIN_PROVIDER / _MODEL and
 * PIBOT_DEV_FALLBACK_PROVIDER / _MODEL pick the ones configured in your Pi Bot.
 */
export const MODELS = {
  main: {
    provider: process.env.PIBOT_DEV_MAIN_PROVIDER ?? "OpenRouter",
    id: process.env.PIBOT_DEV_MAIN_MODEL ?? "deepseek/deepseek-v4.1-flash-1017",
  },
  fallback: {
    provider: process.env.PIBOT_DEV_FALLBACK_PROVIDER ?? "OpenAI",
    id: process.env.PIBOT_DEV_FALLBACK_MODEL ?? "gpt-6.1-sol",
  },
};
/** Waits before each retry on the main model; then the fallback gets FALLBACK_TRIES. */
const RETRY_WAITS_MS = [30_000, 60_000, 120_000, 240_000];
const FALLBACK_TRIES = 2;

/**
 * Pi Bot running without its GUI refuses interactive ACP work, so the harness waits for
 * a window to attach. Ten minutes is enough for a person to notice and open the app; past that,
 * the workflow is blocked on a human and should report rather than keep a job hanging all day.
 */
const INTERACTIVE_WAIT_MS = 30_000;
const INTERACTIVE_WAIT_LIMIT_MS = 10 * 60_000;

const RESUME_AFTER_BUDGET =
  "【pibot-dev 自动续跑】上一轮达到单次运行的预算上限被停下（不是错误，新的一轮有新预算）。从中断处继续收尾：先看工作区和任务笔记里已经做了什么，不要重做；把剩下的做完，跑一次 pnpm check:changed，更新任务笔记，然后简报。";

const RESUME_AFTER_FAILURE =
  "【pibot-dev 自动续跑】上一轮因模型连接问题中断（不是你的错）。从中断处继续：先看工作区里已经改了什么，不要重做已完成的步骤。";

const RESUME_AFTER_OUTPUT_LIMIT =
  "上一轮的单次输出达到上限被截断（程序已自动续写过）。从中断处接着做：先看工作区里已经改了什么，不要重做；后面的输出简短一些，大文件分段写，大段内容写进文件再引用，收尾时跑一次 pnpm check:changed 并更新任务笔记。";

/**
 * A topic whose context is full can never continue — every later turn in it fails the
 * same way (one task ran 115 tools once, then every resume died on context_overflow). Only this
 * case starts a new session, and the worktree plus the task note carry the work across.
 * Fixed wording on purpose: a prompt that varies per turn would lose the provider's prompt cache
 * every time it is reused; the task id is the branch name, so nothing has to be interpolated.
 */
const RESUME_AFTER_CONTEXT_OVERFLOW =
  "上一个会话的上下文已经满了，程序清掉了这个会话，给你开了一个新会话继续这个任务（旧会话仍在应用里，可以自己翻）。先重建现场再动手：任务号就是当前分支名去掉 pibot/ 前缀，读 docs/progress-notes 里这个任务的笔记、本里程碑计划里这一节，看 git status 和 git diff；笔记里记着已经做完的部分不要重做。然后接着把剩下的做完，跑一次 pnpm check:changed，更新任务笔记，最后简报。";

/** The turn ended saying it would continue after a background check. */
const resumeAfterBackground = (note: string) =>
  `后台检查已经出结果了：先读它的结果，把没做完的做完（修问题、跑一次 pnpm check:changed、更新 ${note}），然后简报。不要在检查还没出结果时结束本轮；这次是唯一一次自动接续，直接把结果说清楚。`;

/**
 * turnOnce records a harness failure as `harness_failed` before turn() decides to continue once.
 * The supervisor auto-resumes any `harness_failed` task, so leaving that status during the
 * continuation put two runs on one worktree (three tasks on 2026-11-07). The task is
 * still being worked on until the continuation itself ends.
 */
function markStillRunning(id: string) {
  store.update((state) => {
    const current = state.tasks[id];
    if (current) current.status = "running";
  });
}

/**
 * One workflow step. A transient model failure continues the same topic: four retries with
 * growing waits on the main model, then the fallback model for FALLBACK_TRIES more.
 */
export async function turn(
  task: TaskRecord,
  prompt: string,
  step: StepRecord["step"],
  options: { signal?: AbortSignal } = {},
) {
  assertRepairRecoverable(task);
  options.signal?.throwIfAborted();
  let retries = 0;
  let fallbackTries = 0;
  let budgetContinued = false;
  let outputContinued = false;
  let backgroundContinued = false;
  /** Time spent waiting for a GUI to attach to a headless app. */
  let interactiveWaitMs = 0;
  /** Set when the session was discarded: only this turn's record says so, not the next one's. */
  let sessionReset = false;
  let next = prompt;
  // A resume of a harness_failed task is work in progress too; without this the supervisor saw
  // the old status and resumed the same task a second time while this run was going.
  markStillRunning(task.id);
  for (;;) {
    options.signal?.throwIfAborted();
    try {
      const startedAt = Date.now();
      const result = await turnOnce(task, next, step, { sessionReset, signal: options.signal });
      options.signal?.throwIfAborted();
      // A completed group cycle already includes its delivery check; never start a Bot-style
      // background continuation or a fresh cycle from a coordinator's text.
      if (task.target?.kind === "group") return result;
      // The following turns of this step are ordinary again.
      sessionReset = false;
      // A card nobody answered cancelled this turn (found in review): end the command so the
      // supervisor resumes after answering instead of reviewing an unfinished task.
      if (result.approvalTimeout) throw new AcpHarnessError("acp_failed", "approval_timeout");
      // A turn that ended while its background check still ran is not the end of the task (one
      // was left without its note). task / fix only: the test step is followed by the workflow's own
      // verify, which must not share the worktree with a turn still waiting for a check.
      if (
        !backgroundContinued &&
        (step === "task" || step === "fix") &&
        result.stopReason === "end_turn"
      ) {
        const follow = await followBackgroundTurn(task, {
          text: result.text,
          startedAt,
        });
        if (follow === "note") {
          process.stderr.write(
            `pibot-dev: the background check finished; the automatic turn updated docs/progress-notes/${task.task}.md\n`,
          );
          return result;
        }
        if (follow === "nudge") {
          // Once only: a second wait would be a stuck task, not a slow check.
          backgroundContinued = true;
          next = resumeAfterBackground(`docs/progress-notes/${task.task}.md`);
          process.stderr.write(
            "pibot-dev: the turn ended with its background check unfinished; continuing once\n",
          );
          continue;
        }
      }
      return result;
    } catch (error) {
      // A caller's cancellation is never a transient model error or a new repair invitation.
      if (options.signal?.aborted || task.target?.kind === "group") throw error;
      // A task stopped at 220 tools with the work nearly done: a run budget is per run, so one
      // more turn in the same topic finishes it. Only once: a second stop means the task is too big.
      if (
        error instanceof AcpHarnessError &&
        error.code === "run_failed" &&
        error.detail === "budget_exhausted" &&
        !budgetContinued
      ) {
        budgetContinued = true;
        markStillRunning(task.id);
        task = store.read().tasks[task.id] ?? task;
        next = RESUME_AFTER_BUDGET;
        process.stderr.write("pibot-dev: run budget reached; continuing once to wrap up\n");
        continue;
      }
      // A single response is capped per request; one more turn with a shorter instruction usually
      // finishes the work. Only once: a second cap means the task itself needs splitting.
      if (
        error instanceof AcpHarnessError &&
        error.code === "run_failed" &&
        error.detail === "output_limit" &&
        !outputContinued
      ) {
        outputContinued = true;
        markStillRunning(task.id);
        task = store.read().tasks[task.id] ?? task;
        next = RESUME_AFTER_OUTPUT_LIMIT;
        process.stderr.write("pibot-dev: model output limit reached; continuing once\n");
        continue;
      }
      // A full context is permanent for that topic: continuing it fails every time.
      // Drop the remembered session so the retry opens a new one, and only once — a second
      // overflow means the task itself is too big for one topic and needs a person.
      if (
        error instanceof AcpHarnessError &&
        error.code === "run_failed" &&
        error.detail === "context_overflow" &&
        !sessionReset
      ) {
        sessionReset = true;
        const full = task.sessionId;
        store.update((state) => {
          const current = state.tasks[task.id];
          if (current) {
            delete current.sessionId;
            // Same as markStillRunning: the fresh session continues this task.
            current.status = "running";
          }
          // A milestone pointing at the full topic would hand the same dead session to the next
          // task of this milestone; it starts a fresh one instead.
          for (const [milestone, topic] of Object.entries(state.milestones ?? {}))
            if (topic.sessionId === full) delete state.milestones?.[milestone];
        });
        task = store.read().tasks[task.id] ?? task;
        next = RESUME_AFTER_CONTEXT_OVERFLOW;
        process.stderr.write(
          "pibot-dev: session context is full; starting a new session once (the old topic stays in the app)\n",
        );
        continue;
      }
      // Another tool holds the app's ACP connections (one at first, four now): wait for a
      // free slot instead of failing; the prompt is unchanged because nothing was sent.
      if (error instanceof AcpHarnessError && error.code === "acp_busy") {
        process.stderr.write("pibot-dev: ACP connection busy; retrying in 30s\n");
        await delay(30_000, undefined, { signal: options.signal });
        continue;
      }
      // Pi Bot is running background-only, so every interactive call is refused until a window
      // attaches. Nothing was sent and nothing in the task is wrong: wait, then report if no
      // person opened the app within the limit.
      if (error instanceof AcpHarnessError && error.code === "interactive_unavailable") {
        if (interactiveWaitMs >= INTERACTIVE_WAIT_LIMIT_MS) throw error;
        process.stderr.write(
          "pibot-dev: Pi Bot has no window attached; waiting up to 10 min for its GUI — open Pi Bot to continue\n",
        );
        await delay(INTERACTIVE_WAIT_MS, undefined, { signal: options.signal });
        interactiveWaitMs += INTERACTIVE_WAIT_MS;
        continue;
      }
      next = RESUME_AFTER_FAILURE;
      const transient =
        error instanceof AcpHarnessError &&
        error.code === "run_failed" &&
        TRANSIENT_RUN_FAILURES.has(error.detail ?? "");
      if (!transient) throw error;
      task = store.read().tasks[task.id] ?? task;
      const onFallback = task.model === "fallback";
      if (onFallback && ++fallbackTries > FALLBACK_TRIES) throw error;
      let wait = RETRY_WAITS_MS[retries] ?? 0;
      if (!onFallback && retries >= RETRY_WAITS_MS.length) {
        store.update((state) => {
          const current = state.tasks[task.id];
          if (current) current.model = "fallback";
        });
        task = store.read().tasks[task.id] ?? task;
        wait = 10_000;
        process.stderr.write(
          `pibot-dev: main model failed ${retries + 1} times; switching ${task.bot} to ${MODELS.fallback.provider} ${MODELS.fallback.id}\n`,
        );
      } else if (!onFallback) retries++;
      process.stderr.write(`pibot-dev: ${error.message}; continuing in ${wait / 1000}s\n`);
      // The failed run's topic still holds the work so far.
      await delay(wait, undefined, { signal: options.signal });
    }
  }
}

async function turnOnce(
  task: TaskRecord,
  prompt: string,
  step: StepRecord["step"],
  options: { sessionReset?: boolean; signal?: AbortSignal } = {},
) {
  // No wait for the Bot's other runs: tasks run in parallel topics (maintainers 2026-11-05), and a
  // message sent to a topic that is still running queues behind that run in Pi Bot.
  mkdirSync(dirname(store.logPath(task.id)), { recursive: true });
  let dispatch: AcpDispatchIdentity | undefined;
  let lastGroup = "";
  try {
    const result = await runAcpTurn({
      app: runningApp(),
      cwd: task.worktree,
      bot: task.bot,
      ...(task.target?.kind === "group"
        ? {
            group: task.target.groupId ? `group:${task.target.groupId}` : task.target.name,
            onGroupState: (group: import("../../packages/acp/src/types.ts").AcpGroupSnapshot) => {
              const encoded = JSON.stringify(group);
              if (encoded === lastGroup) return;
              if (dispatch) recordRepairGroup(task, dispatch, group);
              store.update((state) => {
                const current = state.tasks[task.id];
                if (
                  !current ||
                  current.worktree !== task.worktree ||
                  current.target?.kind !== "group"
                )
                  throw new Error("group_task_identity_changed");
                current.group = group;
                current.target.groupId = group.groupId;
              });
              lastGroup = encoded;
              process.stdout.write(`[group] ${group.state} · ${group.runIds.length} runs\n`);
            },
          }
        : {}),
      prompt,
      logPath: store.logPath(task.id),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(3 * 60 * 60 * 1000)])
        : AbortSignal.timeout(3 * 60 * 60 * 1000),
      ...(options.signal || task.target?.kind === "group"
        ? {
            onDispatch: (identity: AcpDispatchIdentity) => {
              markRepairDispatched(task, identity);
              dispatch = identity;
            },
          }
        : {}),
      // An approval card in the app is invisible to this script; say so instead of looking idle.
      onApprovalWait: ({ minutes, title }) => {
        process.stdout.write(
          `pibot-dev: waiting for an approval in the app for ${minutes} min: ${title}\n`,
        );
        record(task.id, {
          step: "approval_wait",
          at: now(),
          outcome: "ok",
          detail: `${minutes} min: ${title}`,
        });
      },
      onApprovalTimeout: ({ minutes, title }) => {
        process.stderr.write(
          `pibot-dev: approval not answered for ${minutes} min (${title}); cancelled this turn — answer the card in the app, then resume\n`,
        );
      },
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
      ...(task.target?.kind === "group" ? {} : { model: MODELS[task.model ?? "main"] }),
    });
    if (
      dispatch &&
      (result.group
        ? result.group.drained && result.group.terminal
        : result.stopReason !== "cancelled")
    ) {
      clearSettledRepair(task, dispatch);
      dispatch = undefined;
    }
    if (dispatch && (task.target?.kind === "group" || result.stopReason === "cancelled"))
      throw new Error("repair_cleanup_unconfirmed");
    if (task.target?.kind === "group" && result.stopReason !== "end_turn") {
      const failure = new AcpHarnessError("run_failed", "group_cancelled");
      failure.group = result.group;
      failure.sessionId = result.sessionId;
      throw failure;
    }
    options.signal?.throwIfAborted();
    record(
      task.id,
      {
        step,
        at: now(),
        outcome: result.stopReason === "end_turn" ? "ok" : "failed",
        detail: result.approvalTimeout ? "approval_timeout" : result.stopReason,
        durationMs: result.durationMs,
        tools: result.tools,
        failedTools: result.failedTools,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.group ? { group: result.group } : {}),
        sessionId: result.sessionId,
        continued: result.continued,
        ...(options.sessionReset ? { sessionReset: true } : {}),
      },
      {
        sessionId: result.sessionId,
        botId: result.botId,
        ...(result.group ? { group: result.group } : {}),
      },
    );
    // cacheRead / (input + cacheRead) is the share of prompt tokens served from the
    // provider's prompt cache; the fixed system prompt is the bulk of `input` on a miss.
    const usage = result.usage;
    const cacheHit =
      usage && (usage.input ?? 0) + (usage.cacheRead ?? 0) > 0
        ? Math.round(((usage.cacheRead ?? 0) / ((usage.input ?? 0) + (usage.cacheRead ?? 0))) * 100)
        : undefined;
    process.stdout.write(
      `${result.text.trim()}\n\n[${step}] ${result.stopReason} · ${Math.round(result.durationMs / 1000)}s · tools ${result.tools} (failed ${result.failedTools})${result.continued ? " · same topic" : " · new topic"}${cacheHit === undefined ? "" : ` · cache 命中 ${cacheHit}%`}\n`,
    );
    return result;
  } catch (error) {
    if (dispatch) {
      if (
        error instanceof AcpHarnessError &&
        ((task.target?.kind === "group" &&
          error.code === "run_failed" &&
          error.detail === "group_unavailable" &&
          error.rejectedDispatchId === dispatch.dispatchId &&
          error.sessionId === dispatch.sessionId &&
          !error.group) ||
          (!options.signal?.aborted &&
            error.code === "run_failed" &&
            (task.target?.kind !== "group" || !!(error.group?.terminal && error.group.drained))))
      ) {
        clearSettledRepair(task, dispatch);
        dispatch = undefined;
      } else {
        record(
          task.id,
          {
            step,
            at: now(),
            outcome: "harness_failed",
            detail: "repair_cleanup_unconfirmed",
            ...(error instanceof AcpHarnessError && error.group ? { group: error.group } : {}),
          },
          {
            status: "harness_failed",
            ...(error instanceof AcpHarnessError && error.group ? { group: error.group } : {}),
          },
        );
        throw new Error("repair_cleanup_unconfirmed");
      }
    }
    if (options.signal?.aborted) {
      if (task.target?.kind === "group")
        record(
          task.id,
          { step, at: now(), outcome: "task_failed", detail: "workflow_cancelled" },
          { status: "task_failed" },
        );
      throw error;
    }
    // Waiting for a free ACP connection or for a window to attach is not a step: recording each
    // retry made one task's retro count 42 workflow failures and left waiting tasks harness_failed.
    if (
      error instanceof AcpHarnessError &&
      (error.code === "acp_busy" || error.code === "interactive_unavailable")
    )
      throw error;
    // The workflow itself broke: Claude fixes Pi Bot / ACP / this script, then resumes.
    const harness = error instanceof AcpHarnessError;
    const groupFailed =
      task.target?.kind === "group" && harness && error.group?.terminal && error.group.drained;
    record(
      task.id,
      {
        step,
        at: now(),
        outcome: groupFailed ? "task_failed" : harness ? "harness_failed" : "failed",
        detail: String(error).slice(0, 500),
        ...(error instanceof AcpHarnessError && error.group ? { group: error.group } : {}),
      },
      {
        ...(groupFailed
          ? { status: "task_failed" as const }
          : harness
            ? { status: "harness_failed" as const }
            : {}),
        ...(harness && error.sessionId ? { sessionId: error.sessionId } : {}),
        ...(harness && error.group ? { group: error.group } : {}),
      },
    );
    throw error;
  }
}
