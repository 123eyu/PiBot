import { existsSync, realpathSync } from "node:fs";
import { changeSet, committedEntry, docsOnly } from "./changes.ts";
import { git, now, repo, store } from "./context.ts";
import { acquireOperationLock } from "./operation-lock.ts";
import type { StepRecord, TaskRecord } from "./state.ts";
import { syncMain } from "./worktree.ts";

export function current(task: TaskRecord, step: StepRecord["step"], changes: { digest: string }) {
  const last = task.steps.findLast((item) => item.step === step);
  return changes.digest.startsWith("v2:") && last?.diffDigest === changes.digest ? last : undefined;
}
function fresh(task: TaskRecord) {
  const value = store.read().tasks[task.id];
  if (!value || value.worktree !== task.worktree || value.branch !== task.branch)
    throw new Error("Task identity changed");
  return value;
}
function taskIdentity(task: TaskRecord) {
  if (!/^[a-z0-9-]+$/.test(task.id) || task.branch !== `pibot/${task.id}`)
    throw new Error("Invalid task branch");
}
function taskLocation(task: TaskRecord) {
  taskIdentity(task);
  const mainPath = realpathSync(repo);
  if (realpathSync(task.worktree) === mainPath) throw new Error("Refusing the main worktree");
  const common = (cwd: string) =>
    realpathSync(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  if (common(task.worktree) !== common(repo)) throw new Error("Foreign task worktree");
  const registered = git(repo, "worktree", "list", "--porcelain")
    .split("\n\n")
    .some((block) => {
      const lines = block.split("\n");
      const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
      return (
        path &&
        existsSync(path) &&
        realpathSync(path) === realpathSync(task.worktree) &&
        lines.includes(`branch refs/heads/${task.branch}`)
      );
    });
  if (!registered || git(task.worktree, "symbolic-ref", "--short", "HEAD") !== task.branch)
    throw new Error("Task worktree/branch no longer matches");
}
function mainReady() {
  if (
    git(repo, "symbolic-ref", "--short", "HEAD") !== "main" ||
    git(repo, "status", "--porcelain") !== ""
  )
    throw new Error("Main must be clean and checked out");
}
function ancestor(commit: string, ref: string) {
  try {
    git(repo, "merge-base", "--is-ancestor", commit, ref);
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}
function cleanTree(task: TaskRecord) {
  if (git(task.worktree, "status", "--porcelain") !== "")
    throw new Error("Task has uncommitted work; cleanup refused");
}
function validateReceipts(task: TaskRecord, changes: ReturnType<typeof changeSet>) {
  if (task.status !== "passed" || task.syncConflict || task.checkFailure)
    throw new Error("Task is not approved and idle");
  if (current(task, "review", changes)?.outcome !== "ok")
    throw new Error("Current exact source has no review approval");
  if (docsOnly(changes.files)) return;
  for (const step of ["verify", "package", "test-mac"] as const)
    if (current(task, step, changes)?.outcome !== "ok")
      throw new Error(`Current source needs ${step}`);
  const win = current(task, "test-win", changes);
  if (!win || !["ok", "skipped"].includes(win.outcome))
    throw new Error("Current source needs test-win");
  if (
    win.outcome === "ok" &&
    (!win.log ||
      !win.runId ||
      !/^[a-f0-9]{64}$/.test(win.artifactHash ?? "") ||
      !["first-screen", "backend-ready", "app-window"].every((check) =>
        win.stages?.some((stage) => stage.stage === check && stage.outcome === "ok"),
      ))
  )
    throw new Error("Windows success is missing its artifact/stage receipt");
  const packaged = current(task, "package", changes)?.artifact;
  const tested = current(task, "test-mac", changes)?.artifact;
  if (
    !packaged ||
    !tested ||
    packaged.digest !== tested.digest ||
    packaged.arch !== tested.arch ||
    packaged.version !== tested.version
  )
    throw new Error("Package and Mac test artifact identity do not match");
}
function validateReleaseState(task: TaskRecord) {
  taskIdentity(task);
  const state = task.finishState;
  if (!state) return;
  const phase = ["prepared", "committed", "merged", "recorded", "cleaned"].indexOf(state.phase);
  const oid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
  if (
    phase < 0 ||
    !/^v2:[a-f0-9]{64}$/.test(state.digest) ||
    ![state.baseOid, state.startOid, state.treeOid].every(oid) ||
    (phase >= 1 && !oid(state.commitOid)) ||
    (phase >= 2 && !oid(state.mainOid))
  )
    throw new Error("Invalid durable release receipt");
  const expectedStatus = phase >= 3 ? "finished" : "passed";
  if (task.status !== expectedStatus || task.syncConflict || task.checkFailure)
    throw new Error("Release cannot resume from the current task state");
}
function persist(task: TaskRecord, state: NonNullable<TaskRecord["finishState"]>) {
  store.update((all) => {
    const held = all.tasks[task.id];
    if (!held || held.worktree !== task.worktree || held.branch !== task.branch)
      throw new Error("Task identity changed");
    held.finishState = state;
  });
}
function expectedSource(task: TaskRecord, state: NonNullable<TaskRecord["finishState"]>) {
  const changes = changeSet(task, state.baseOid);
  if (changes.digest !== state.digest)
    throw new Error("Frozen release source changed; review again");
  return changes;
}
function releaseGates(task: TaskRecord, state: NonNullable<TaskRecord["finishState"]>) {
  task = fresh(task);
  validateReleaseState(task);
  const changes = expectedSource(task, state);
  validateReceipts(task, changes);
  return changes;
}
function removeMerged(task: TaskRecord, commit: string) {
  if (!ancestor(commit, "main")) throw new Error("Release commit is not on main");
  if (existsSync(task.worktree)) {
    taskLocation(task);
    cleanTree(task);
    if (git(task.worktree, "rev-parse", "HEAD") !== commit)
      throw new Error("Task HEAD changed after release");
    git(repo, "worktree", "remove", task.worktree);
  }
  if (git(repo, "branch", "--list", task.branch)) {
    if (git(repo, "rev-parse", task.branch) !== commit)
      throw new Error("Task branch moved; deletion refused");
    git(repo, "branch", "-d", task.branch);
  }
}

/** Each Git side effect has a durable predecessor so a lost receipt can be recovered by OID. */
export async function finish(task: TaskRecord, options: { signal?: AbortSignal } = {}) {
  const releases = [acquireOperationLock(store.dir, `task-${task.id}`)];
  try {
    releases.push(acquireOperationLock(store.dir, "main"));
    task = fresh(task);
    validateReleaseState(task);
    let state = task.finishState;
    const check = async () => {
      // Deliver queued OS signals after synchronous Git before beginning the next durable stage.
      await new Promise<void>((resolve) => setImmediate(resolve));
      options.signal?.throwIfAborted();
    };
    if (!state) {
      await check();
      taskLocation(task);
      if (task.status !== "passed") throw new Error("Task is not approved and idle");
      syncMain(task);
      task = fresh(task);
      const changes = changeSet(task);
      if (!changes.files.length)
        throw new Error("Nothing to merge without a prepared release receipt");
      validateReceipts(task, changes);
      mainReady();
      await check();
      git(task.worktree, "add", "-A");
      if (changeSet(task).digest !== changes.digest)
        throw new Error("Source changed while freezing release");
      state = {
        phase: "prepared",
        digest: changes.digest,
        baseOid: changes.baseOid,
        startOid: git(task.worktree, "rev-parse", "HEAD"),
        treeOid: git(task.worktree, "write-tree"),
        message: `${task.task}: reviewed Pi Bot task`,
      };
      persist(task, state);
    }
    if (state.phase === "prepared") {
      await check();
      taskLocation(task);
      releaseGates(task, state);
      let commit = git(task.worktree, "rev-parse", "HEAD");
      if (commit !== state.startOid) {
        if (
          git(task.worktree, "rev-parse", "HEAD^") !== state.startOid ||
          git(task.worktree, "rev-parse", "HEAD^{tree}") !== state.treeOid
        )
          throw new Error("Unexpected task commit during release recovery");
      } else if (git(task.worktree, "rev-parse", "HEAD^{tree}") !== state.treeOid) {
        await check();
        const changes = releaseGates(task, state);
        await check();
        validateReceipts(fresh(task), changes);
        git(task.worktree, "commit", "-q", "-m", state.message);
        commit = git(task.worktree, "rev-parse", "HEAD");
      }
      if (git(task.worktree, "rev-parse", `${commit}^{tree}`) !== state.treeOid)
        throw new Error("Commit hooks changed the approved tree");
      cleanTree(task);
      expectedSource(task, state);
      state = { ...state, phase: "committed", commitOid: commit };
      persist(task, state);
    }
    if (state.phase === "committed") {
      const commit = state.commitOid as string;
      await check();
      taskLocation(task);
      cleanTree(task);
      expectedSource(task, state);
      mainReady();
      if (!ancestor(commit, "main")) {
        if (git(repo, "rev-parse", "HEAD") !== state.baseOid)
          throw new Error("Main advanced; new review/validation required");
        await check();
        const changes = releaseGates(task, state);
        await check();
        validateReceipts(fresh(task), changes);
        try {
          git(repo, "merge", "-q", "--no-ff", "-m", `merge: ${task.task}`, commit);
        } catch (error) {
          if (
            existsSync(git(repo, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"))
          )
            git(repo, "merge", "--abort");
          throw error;
        }
      }
      state = { ...state, phase: "merged", mainOid: git(repo, "rev-parse", "HEAD") };
      persist(task, state);
    }
    if (state.phase === "merged") {
      await check();
      if (!ancestor(state.commitOid as string, "main"))
        throw new Error("Main no longer contains the release");
      const recorded = { ...state, phase: "recorded" as const };
      store.update((all) => {
        const held = all.tasks[task.id];
        if (!held) throw new Error("Task disappeared");
        held.steps.push({
          step: "finish",
          at: now(),
          outcome: "ok",
          detail: state?.mainOid,
          diffDigest: state?.digest,
        });
        held.status = "finished";
        held.finishState = recorded;
      });
      state = recorded;
    }
    if (state.phase === "recorded") {
      await check();
      removeMerged(task, state.commitOid as string);
      state = { ...state, phase: "cleaned" };
      persist(task, state);
    }
    return state.mainOid as string;
  } finally {
    for (const release of releases.reverse()) release();
  }
}

export function clean(task: TaskRecord, force = false) {
  const releases = [acquireOperationLock(store.dir, `task-${task.id}`)];
  try {
    releases.push(acquireOperationLock(store.dir, "main"));
    task = fresh(task);
    if (!/^[a-z0-9-]+$/.test(task.id) || task.branch !== `pibot/${task.id}`)
      throw new Error("Invalid task identity");
    if (["running", "testing"].includes(task.status))
      throw new Error("Active task cannot be cleaned");
    if (existsSync(task.worktree)) {
      taskLocation(task);
      if (!force) {
        const changes = changeSet(task);
        if (!ancestor(git(task.worktree, "rev-parse", "HEAD"), "main"))
          throw new Error("Unmerged commits; cleanup refused");
        for (const entry of changes.entries)
          if (JSON.stringify(committedEntry(repo, "main", entry.path)) !== JSON.stringify(entry))
            throw new Error(
              "Main does not contain all task content/deletions; use explicit --force to discard",
            );
      }
      git(repo, "worktree", "remove", ...(force ? ["--force"] : []), task.worktree);
    }
    if (git(repo, "branch", "--list", task.branch))
      git(repo, "branch", force ? "-D" : "-d", task.branch);
    store.update((all) => {
      delete all.tasks[task.id];
    });
  } finally {
    for (const release of releases.reverse()) release();
  }
}
