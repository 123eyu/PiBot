// pnpm pibot-dev <command> — the self-iteration workflow.
// Claude plans and reviews; a Pi Bot Bot implements over ACP in its own worktree; this script
// runs the fixed sandbox-outside steps. Run outside any agent sandbox (it installs, builds and
// launches apps).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setImmediate as yieldForCancellation } from "node:timers/promises";
import { deleteAcpSessions } from "./acp-client.ts";
import { activeRuns, builtApp, install, ownerData, packageMain } from "./app.ts";
import { batchTasks } from "./batch.ts";
import { exceptionReason } from "./check-failure.ts";
import { checkChanged, type VerifyResult } from "./checks.ts";
import { argValue, git, now, pnpmEnv, record, repo, setStatus, store, taskOf } from "./context.ts";
import { targetKey, taskActor } from "./group-target.ts";
import { acquireOperationLock } from "./operation-lock.ts";
import { followUpPrompt, planSection, taskPrompt } from "./prompts.ts";
import { clean as cleanRelease } from "./release-task.ts";
import { assertRepairRecoverable } from "./repair-marker.ts";
import { retro } from "./retro.ts";
import { retroAll } from "./retro-all.ts";
import { approve as approveSnapshot, review as reviewSnapshot } from "./review-snapshot.ts";
import type { TaskRecord } from "./state.ts";
import { finish, packageTask, testMacTask, testWinTask } from "./steps.ts";
import { runningApp, turn } from "./turn.ts";
import { verifyAsync } from "./verify-async.ts";
import { ensureElectronAsync } from "./windows/electron.ts";
import {
  changeSet,
  clearSyncConflict,
  ensureElectron,
  seedBuildCache,
  snapshotWorktree,
  syncMain,
} from "./worktree.ts";

const DEFAULT_BOT = "小栈";
const MAX_TEST_ROUNDS = 3;
/** One failure round back to the topic, then the task is handed over marked 检查未过. */
const MAX_CHECK_CHANGED_ROUNDS = 2;
const reviewFile = (id: string) => join(store.dir, "reviews", `${id}.md`);
const out = (text: string) => process.stdout.write(`${text}\n`);
/** A restarted app forgets the session; the header keeps a new topic on the same task. */
const header = (task: TaskRecord) =>
  `任务 ${task.task}（里程碑 ${task.milestone}，计划 docs/plans/${task.milestone}-plan.md 的「### ${task.task}」）。`;

function sync(task: TaskRecord) {
  if (syncMain(task)) out(`pibot-dev: merged main into ${task.branch}`);
}

async function startTask(args: string[], signal?: AbortSignal) {
  const [milestone, name] = args;
  if (!milestone || !name)
    throw new Error(
      "usage: pibot-dev task <M> <M-Tn> [--bot 小栈 | --group 群名或group:ID] [--prompt file] [--base <task id>]",
    );
  const actor = taskActor(args, DEFAULT_BOT);
  const id = name.toLowerCase();
  if (store.read().tasks[id]) throw new Error(`task ${id} exists; use resume, or clean it first`);
  const section = planSection(repo, milestone, name);
  const extraFile = argValue(args, "--prompt");
  const worktree = resolve(repo, "..", "PiBot-wt", `pibot-${id}`);
  const branch = `pibot/${id}`;
  // --base: start before a prerequisite branch has merged, so the Bot does not wait for its
  // verify (maintainers 2026-11-04: 小栈 sat idle while Claude's checks ran). Sync with main later
  // brings the merged prerequisite in as the same commits.
  // --base <task id>: start from that task's current worktree state (snapshot commit).
  const baseTask = argValue(args, "--base");
  const prerequisite = baseTask ? store.read().tasks[baseTask.toLowerCase()] : undefined;
  if (baseTask && !prerequisite) throw new Error(`--base ${baseTask}: unknown task`);
  const base = prerequisite
    ? snapshotWorktree(
        prerequisite.worktree,
        `pibot-dev snapshot of ${prerequisite.task} for ${name}`,
      )
    : "main";
  if (!existsSync(worktree)) {
    git(repo, "worktree", "add", "-q", "-b", branch, worktree, base);
    // Before the Bot's first check:changed, which would otherwise build every package from zero.
    const seeded = seedBuildCache(worktree);
    if (seeded) out(`pibot-dev: seeded ${seeded} tsc build cache(s) from main`);
  }
  // Outside the sandbox and before the Bot starts: installs are a fixed workflow step.
  execFileSync("pnpm", ["install", "--frozen-lockfile"], {
    cwd: worktree,
    stdio: "inherit",
    env: pnpmEnv,
  });
  ensureElectron(worktree);
  const task: TaskRecord = {
    id,
    milestone,
    task: name,
    ...actor,
    branch,
    worktree,
    status: "running",
    steps: [],
  };
  const state = store.read();
  const remembered = state.milestones?.[milestone];
  const rememberedTask = remembered ? state.tasks[remembered.lastTask.toLowerCase()] : undefined;
  const sameTarget =
    remembered?.targetKey === targetKey(task.target, task.bot) ||
    (!remembered?.targetKey &&
      rememberedTask &&
      targetKey(rememberedTask.target, rememberedTask.bot) === targetKey(task.target, task.bot));
  // Maintainers 2026-11-05: tasks of one milestone may run in parallel. While the task that owns the
  // milestone's topic is still active (coding, testing, not merged), this one gets its own topic:
  // a topic runs one task at a time and is bound to one worktree, and loading it would only fail.
  // The milestone then remembers the newest topic, so the next task continues there.
  const ownerActive = Object.values(state.tasks).some(
    (other) =>
      other.milestone === milestone &&
      other.status !== "finished" &&
      other.sessionId === remembered?.sessionId,
  );
  const previous = ownerActive || !sameTarget ? undefined : remembered;
  if (previous) task.sessionId = previous.sessionId;
  store.update((state) => {
    state.tasks[id] = task;
  });
  const extra = extraFile ? { extra: readFileSync(extraFile, "utf8") } : {};
  const after = previous ? { after: { task: previous.lastTask, worktree } } : {};
  await turn(
    task,
    taskPrompt({
      milestone,
      task: name,
      section,
      ...extra,
      ...after,
      ...(task.target?.kind === "group" ? { group: task.target.name } : {}),
    }),
    "task",
    task.target?.kind === "group" ? { signal } : {},
  );
  // The milestone's topic is now this task's (a failed load fell back to a new session).
  store.update((state) => {
    const sessionId = state.tasks[id]?.sessionId;
    if (!sessionId) return;
    state.milestones ??= {};
    state.milestones[milestone] = {
      sessionId,
      lastTask: name,
      targetKey: targetKey(task.target, task.bot),
    };
  });
  await checkBeforeReview(task, task.target?.kind === "group" ? signal : undefined);
  setStatus(id, "waiting_review");
}

/**
 * Archives the topics of task sessions nothing will continue in (maintainers 2026-11-05): sessions of
 * merged, cleaned or restarted tasks, except each milestone's current topic and any session an
 * active task still uses. Pi Bot keeps them under 已归档; nothing is deleted.
 */
async function tidy() {
  const state = store.read();
  const keep = new Set(Object.values(state.milestones ?? {}).map((m) => m.sessionId));
  const seen = new Set<string>();
  for (const task of Object.values(state.tasks)) {
    const ids = [task.sessionId, ...task.steps.map((step) => step.sessionId)].filter(
      (id): id is string => !!id,
    );
    for (const id of ids) seen.add(id);
    if (task.status !== "finished") for (const id of ids) keep.add(id);
  }
  // Restarted tasks lose their state record; Pi Bot's own ACP session file still lists them.
  // Only sessions whose folder is a pibot-dev task worktree: other ACP clients' sessions stay.
  const active = new Set(
    Object.values(state.tasks)
      .filter((task) => task.status !== "finished")
      .map((task) => task.worktree),
  );
  for (const { id, root } of appTaskSessions()) if (!active.has(root)) seen.add(id);
  const stale = [...seen].filter((id) => !keep.has(id) && !state.tidied?.includes(id));
  if (!stale.length) return out("tidy: nothing to archive");
  let result: Awaited<ReturnType<typeof deleteAcpSessions>>;
  try {
    result = await deleteAcpSessions(runningApp(), stale);
  } catch (error) {
    // Tidying is cosmetic: a closed app or an older build without session/delete must not fail
    // the merge that just happened. The next finish or tidy tries again.
    return out(`tidy: skipped (${String(error).slice(0, 200)})`);
  }
  store.update((next) => {
    next.tidied = [...(next.tidied ?? []), ...result.deleted].slice(-512);
  });
  out(`tidy: archived ${result.deleted.length} session(s), skipped ${result.skipped.length}`);
}

function appTaskSessions(): { id: string; root: string }[] {
  const worktrees = resolve(repo, "..", "PiBot-wt");
  try {
    const stored = JSON.parse(readFileSync(join(ownerData, "acp-sessions.json"), "utf8")) as {
      records?: { id?: unknown; roots?: unknown }[];
    };
    return (stored.records ?? []).flatMap((record) =>
      typeof record.id === "string" &&
      Array.isArray(record.roots) &&
      typeof record.roots[0] === "string" &&
      record.roots[0].startsWith(join(worktrees, "pibot-"))
        ? [{ id: record.id, root: record.roots[0] }]
        : [],
    );
  } catch {
    // No file yet, or an unreadable one: state alone still names this run's sessions.
    return [];
  }
}

/** Prints the change set for Claude's review and remembers which content it is. */
function review(task: TaskRecord) {
  const changes = reviewSnapshot(task);
  out(`files (${changes.files.length}):\n${changes.files.map((file) => `  ${file}`).join("\n")}`);
  out(`source-digest: ${changes.digest} · diff ${changes.diffFile}`);
  out(
    `write ${reviewFile(task.id)} containing a line source-digest: ${changes.digest} and ending review:pass or review:changes-required, then pibot-dev approve ${task.id}`,
  );
}

function approve(task: TaskRecord, file = reviewFile(task.id)) {
  const result = approveSnapshot(task, file);
  out(
    result.pass ? `approved ${result.digest}` : `changes requested; next: pibot-dev fix ${task.id}`,
  );
}

/** Records a check result on the task and returns whether it was a failure worth a fix round. */
function recordCheck(task: TaskRecord, result: ReturnType<typeof checkChanged>) {
  record(task.id, {
    step: "check-changed",
    at: now(),
    outcome:
      result.state === "harness_failed"
        ? "harness_failed"
        : result.state === "failed"
          ? "failed"
          : "ok",
    detail:
      result.state === "harness_failed"
        ? result.failure?.reason
        : result.state === "failed"
          ? `failed: ${result.failed.join(", ") || "unknown"}`
          : result.state,
    ...(result.durationMs ? { durationMs: result.durationMs } : {}),
    ...(result.log ? { log: result.log } : {}),
  });
}

function clearCheckFailure(id: string) {
  store.update((state) => {
    const current = state.tasks[id];
    if (current?.checkFailure) delete current.checkFailure;
  });
}

/**
 * Before a task is marked 待审, make sure the check result it carries is about the work it
 * ships. A turn that edited code after its last `pnpm check:changed` gets the check rerun here; a
 * failure goes back to the same topic for one fix round, and a second failure hands the task over
 * anyway, marked 检查未过, so Claude sees it before verify is the first to notice.
 */
async function checkBeforeReview(task: TaskRecord, signal?: AbortSignal) {
  for (let round = 1; round <= MAX_CHECK_CHANGED_ROUNDS; round++) {
    signal?.throwIfAborted();
    const result = checkChanged(task);
    signal?.throwIfAborted();
    recordCheck(task, result);
    if (result.state === "harness_failed") {
      setStatus(task.id, "harness_failed");
      throw new Error(
        `check:changed workflow failed: ${result.failure?.reason}; see ${result.log}`,
      );
    }
    if (result.state === "fresh") {
      clearCheckFailure(task.id);
      return;
    }
    if (result.state === "passed") {
      clearCheckFailure(task.id);
      out(
        `pibot-dev: work changed after the Bot's own check; check:changed passed again in ${Math.round((result.durationMs ?? 0) / 1000)}s (${result.log})`,
      );
      return;
    }
    const detail = `failed: ${result.failed.join(", ") || "unknown"}`;
    store.update((state) => {
      const current = state.tasks[task.id];
      if (current)
        current.checkFailure = {
          at: now(),
          detail,
          ...(result.log ? { log: result.log } : {}),
        };
    });
    out(`pibot-dev: check:changed failed on the work done after the Bot's own run; ${result.log}`);
    if (round === MAX_CHECK_CHANGED_ROUNDS) {
      process.stderr.write("pibot-dev: check:changed still fails; handing over marked 检查未过\n");
      return;
    }
    const body = `失败的步骤：${result.failed.join("、") || "未知"}\n完整输出：${result.log}\n\n${result.excerpt}`;
    await turn(
      task,
      `${header(task)}\n\n${followUpPrompt("check", body)}`,
      "fix",
      task.target?.kind === "group" ? { signal } : {},
    );
  }
}

/**
 * A conflicted worktree is merged by Claude, not by a Bot turn (maintainers 2026-11-06): a turn would
 * edit files under markers and could drop one side of the conflict.
 */
function refuseSyncConflict(task: TaskRecord, command: string) {
  if (task.status !== "sync_conflict") return;
  const files = task.syncConflict?.files.join("、") ?? "see git status";
  throw new Error(
    `${task.id} 的同步冲突还没解决（${files}）；冲突由 Claude 解决后运行 pibot-dev conflict-done ${task.id}，不跑 ${command}`,
  );
}

/**
 * Claude resolved the conflict by hand; this only clears what git left behind: refuse while
 * markers remain, then drop the unmerged index entries (the resolved content stays), the sync
 * stash and the state flag. No model turn.
 */
function conflictDone(task: TaskRecord) {
  if (!task.syncConflict) throw new Error(`${task.id} has no sync conflict to clear`);
  clearSyncConflict(task);
  out(`sync conflict cleared; next: pibot-dev review ${task.id}`);
}

async function fix(task: TaskRecord, source = reviewFile(task.id), signal?: AbortSignal) {
  refuseSyncConflict(task, "fix");
  if (task.target?.kind === "group") assertRepairRecoverable(task);
  const body = existsSync(source) ? readFileSync(source, "utf8") : source;
  sync(task);
  setStatus(task.id, "running");
  await turn(
    task,
    `${header(task)}\n\n${followUpPrompt("fix", body)}`,
    "fix",
    task.target?.kind === "group" ? { signal } : {},
  );
  await checkBeforeReview(task, task.target?.kind === "group" ? signal : undefined);
  setStatus(task.id, "waiting_review");
}

/** Preflight and adapter exceptions are workflow failures, with no command output in state. */
async function verifyTask(task: TaskRecord, signal: AbortSignal) {
  let digest: string | undefined;
  let result: VerifyResult | undefined;
  try {
    signal?.throwIfAborted();
    assertRepairRecoverable(task);
    sync(task);
    signal.throwIfAborted();
    digest = changeSet(task).digest;
    setStatus(task.id, "testing");
    result = await verifyAsync(task, {
      signal,
      prepare: () => ensureElectronAsync(task.worktree, { signal }),
    });
    await yieldForCancellation();
    if (result.failure?.reason === "process_cleanup_unconfirmed")
      throw new Error("process_cleanup_unconfirmed");
    signal?.throwIfAborted();
    if (changeSet(task).digest !== digest) throw new Error("source_changed_during_verify");
    return { result, digest };
  } catch (error) {
    // syncMain owns the conflict state; operator resolution must remain mandatory.
    const conflict = store.read().tasks[task.id]?.status === "sync_conflict";
    const reason = conflict
      ? "sync_conflict"
      : result?.failure?.reason === "process_cleanup_unconfirmed"
        ? "process_cleanup_unconfirmed"
        : error instanceof Error && error.message === "repair_cleanup_unconfirmed"
          ? "repair_cleanup_unconfirmed"
          : signal.aborted
            ? "workflow_cancelled"
            : exceptionReason(error);
    record(
      task.id,
      {
        step: "verify",
        at: now(),
        outcome: "harness_failed",
        detail: reason,
        ...(digest ? { diffDigest: digest } : {}),
        ...(result ? { log: result.log, durationMs: result.durationMs } : {}),
      },
      { status: conflict ? "sync_conflict" : "harness_failed" },
    );
    throw new Error(`verify workflow failed: ${reason}`);
  }
}

/** Full verify outside the sandbox; failures go back to the Bot, at most three rounds. */
async function test(task: TaskRecord, signal = new AbortController().signal) {
  let observed: { result: VerifyResult; digest: string } | undefined;
  let repairing = false;
  try {
    for (let round = 1; ; round++) {
      out(`pibot-dev: verify round ${round}`);
      const { result, digest } = await verifyTask(task, signal);
      observed = { result, digest };
      await yieldForCancellation();
      signal.throwIfAborted();
      const flaky = result.flaky.length ? ` (flaky, passed alone: ${result.flaky.join(", ")})` : "";
      record(task.id, {
        step: "verify",
        at: now(),
        outcome: result.ok ? "ok" : result.failure?.kind !== "task" ? "harness_failed" : "failed",
        detail: result.ok
          ? `passed${flaky}`
          : result.failure?.kind !== "task"
            ? (result.failure?.reason ?? "unclassified_check_failure")
            : `failed: ${result.failed.join(", ") || "unknown"}`,
        durationMs: result.durationMs,
        diffDigest: digest,
        log: result.log,
      });
      if (result.ok) {
        signal.throwIfAborted();
        setStatus(task.id, "waiting_review");
        out(
          `verify passed in ${Math.round(result.durationMs / 60000)} min${flaky}; review the final diff next`,
        );
        return;
      }
      if (result.failure?.kind !== "task") {
        setStatus(task.id, "harness_failed");
        throw new Error(
          `verify workflow failed: ${result.failure?.reason ?? "unclassified_check_failure"}; see ${result.log}`,
        );
      }
      if (round >= MAX_TEST_ROUNDS) {
        setStatus(task.id, "task_failed");
        throw new Error(`verify still fails after ${round} rounds; see ${result.log}`);
      }
      const body = `失败的步骤：${result.failed.join("、") || "未知"}\n完整输出：${result.log}\n\n${result.excerpt}`;
      await yieldForCancellation();
      signal.throwIfAborted();
      setStatus(task.id, "running");
      repairing = true;
      await turn(task, `${header(task)}\n\n${followUpPrompt("test", body)}`, "test", { signal });
      repairing = false;
      await yieldForCancellation();
      signal.throwIfAborted();
    }
  } catch (error) {
    const status = store.read().tasks[task.id]?.status;
    if (!status || !["harness_failed", "task_failed", "sync_conflict"].includes(status)) {
      const reason =
        error instanceof Error &&
        ["repair_cleanup_unconfirmed", "repair_metadata_unavailable"].includes(error.message)
          ? error.message
          : signal.aborted
            ? "workflow_cancelled"
            : exceptionReason(error);
      record(
        task.id,
        {
          step: repairing ? "test" : "verify",
          at: now(),
          outcome: "harness_failed",
          detail: reason,
          ...(observed
            ? {
                diffDigest: observed.digest,
                log: observed.result.log,
                durationMs: observed.result.durationMs,
              }
            : {}),
        },
        { status: "harness_failed" },
      );
    }
    throw error;
  }
}

async function installCommand(args: string[], signal: AbortSignal) {
  signal.throwIfAborted();
  let packaged: string | undefined;
  if (args.includes("--build")) {
    const run = await packageMain(signal);
    signal.throwIfAborted();
    if (!run.ok) throw new Error(`main package failed; see ${run.log}`);
    packaged = run.artifact?.path;
  }
  const app = argValue(args, "--app") ?? packaged ?? builtApp(repo);
  if (!app) throw new Error("no built app; pass --build or --app");
  const waitMin = Number(argValue(args, "--wait") ?? "120");
  signal.throwIfAborted();
  await install(app, waitMin * 60 * 1000, signal);
  signal.throwIfAborted();
  out(`installed ${app} → /Applications and reopened`);
}

function clean(task: TaskRecord, force = false) {
  cleanRelease(task, force);
  out(`removed ${task.id}`);
}

const USAGE =
  "task <M> <M-Tn> | fix <id> [review.md] | conflict-done <id> | resume <id> <message> | review <id> | approve <id> [review.md] | test <id> | batch <id> <id> [...] | package <id> | test-mac <id> [flow|script.ts…] | test-win <id> --check first-screen --check backend-ready --check app-window | finish <id> | tidy | install [--build|--app path] [--wait min] | retro <id> | retro --all [--since ISO] | status | logs <id> | busy | clean <id> [--force]";

async function dispatch(argv: string[], signal: AbortSignal) {
  const [command, ...args] = argv;
  const task = () => taskOf(args[0], `pibot-dev ${command} <id>`);
  switch (command) {
    case "task":
      return startTask(args, signal);
    case "fix":
      return fix(task(), args[1], signal);
    case "conflict-done":
      return conflictDone(task());
    case "resume": {
      if (!args[1]) throw new Error("usage: pibot-dev resume <id> <message|file>");
      refuseSyncConflict(task(), "resume");
      const body = existsSync(args[1]) ? readFileSync(args[1], "utf8") : args[1];
      const target = task();
      await turn(
        target,
        `${header(target)}\n\n${body}`,
        "task",
        target.target?.kind === "group" ? { signal } : {},
      );
      // A finished resume is ready for review like a finished fix, otherwise the task stays
      // "running" with no process (seen 2026-11-07); the check has to be about the work it ends on.
      await checkBeforeReview(target, target.target?.kind === "group" ? signal : undefined);
      setStatus(target.id, "waiting_review");
      return;
    }
    case "review":
      return review(task());
    case "approve":
      return approve(task(), args[1]);
    case "test":
      return test(task(), signal);
    case "batch":
      return batchTasks(args);
    case "package":
      return packageTask(task(), signal);
    case "test-mac":
      return testMacTask(task(), args.slice(1), signal);
    case "test-win":
      return testWinTask(task(), parseWindowsChecks(args.slice(1)), signal);
    case "finish":
      out(`merged into main at ${await finish(task(), { signal })}`);
      return tidy();
    case "tidy":
      return tidy();
    case "install":
      return installCommand(args, signal);
    case "retro": {
      if (!args.includes("--all")) return out(retro(task()));
      const since = argValue(args, "--since");
      const at = since ? Date.parse(since) : Number.NaN;
      if (since && Number.isNaN(at)) throw new Error(`--since ${since}: not a date`);
      return out(retroAll(at ? { since: new Date(at).toISOString() } : {}));
    }
    case "busy":
      return out(activeRuns().join("\n") || "idle");
    case "clean":
      return clean(task(), args.includes("--force"));
    case "status": {
      for (const t of Object.values(store.read().tasks)) {
        const last = t.steps.at(-1);
        out(
          `${t.id}\t${t.status}${t.checkFailure ? "（检查未过）" : ""}\t${t.bot}\t${last ? `${last.step}:${last.outcome}` : "-"}\t${t.worktree}`,
        );
      }
      return;
    }
    case "logs": {
      const id = args[0]?.toLowerCase();
      if (!id) throw new Error("usage: pibot-dev logs <id>");
      return out(readFileSync(store.logPath(id), "utf8").split("\n").slice(-80).join("\n"));
    }
    default:
      throw new Error(`unknown command ${command ?? ""}\n${USAGE}`);
  }
}

function parseWindowsChecks(args: string[]): string[] {
  const checks: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    if (
      args[index] !== "--check" ||
      !["first-screen", "backend-ready", "app-window"].includes(args[index + 1] ?? "")
    )
      throw new Error("test-win accepts only --check first-screen|backend-ready|app-window");
    checks.push(args[index + 1] as string);
  }
  return [...new Set(checks)];
}

async function main(argv: string[]) {
  const [command, ...args] = argv;
  const controller = new AbortController();
  const stop = () => {
    controller.abort(new DOMException("Workflow cancelled", "AbortError"));
    process.exitCode = 130;
  };
  // Legacy Bot task turns retain their disconnect-on-process-exit cancellation path.
  const groupCommand =
    command === "task"
      ? args.includes("--group")
      : ["fix", "resume"].includes(command ?? "") &&
        !!args[0] &&
        store.read().tasks[args[0].toLowerCase()]?.target?.kind === "group";
  const cooperative =
    groupCommand ||
    [
      "test",
      "finish",
      "install",
      "clean",
      "review",
      "approve",
      "package",
      "test-mac",
      "test-win",
    ].includes(command ?? "");
  if (cooperative) {
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
  const scoped = new Set([
    "task",
    "fix",
    "resume",
    "review",
    "approve",
    "test",
    "package",
    "test-mac",
    "test-win",
    "conflict-done",
  ]);
  const ids =
    command === "batch"
      ? args.filter((arg) => !arg.startsWith("--"))
      : command && scoped.has(command)
        ? [args[command === "task" ? 1 : 0]].filter((id): id is string => !!id)
        : [];
  const releases: (() => void)[] = [];
  try {
    for (const id of [...new Set(ids.map((id) => id.toLowerCase()))].sort())
      releases.push(acquireOperationLock(store.dir, `task-${id}`));
    controller.signal.throwIfAborted();
    await dispatch(argv, controller.signal);
    controller.signal.throwIfAborted();
  } finally {
    for (const release of releases.reverse()) release();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`pibot-dev: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode ||= 1;
});
