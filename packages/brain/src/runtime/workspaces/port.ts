import type { LocalToolResult } from "@pibot/agent";
import type {
  CommandResult,
  GitReader,
  GitWriteOperation,
  ManagedGitRepository,
} from "@pibot/execution";
import type {
  ChangesDiff,
  ChangesTarget,
  ChangesTurn,
  FileRestore,
  Group,
  Run,
} from "@pibot/protocol-base";
import type { GroupMemberWorkspace, ManagedRecord, RunFileChangesRepo } from "@pibot/storage";
import type { PreparedTool, ToolRunContext } from "../../core/local-types.ts";
import type { groupWorkplace } from "../../resources/groups/group-workplace.ts";
import type { ChangesScope, WorktreeReceipt } from "./types.ts";

export type { ChangesRoot, ChangesScope, WorktreeReceipt } from "./types.ts";
export interface BeforeWrite {
  existed: boolean;
  beforeRef: string | null;
  beforeMode?: number | null;
}
/** The engine owns call order and run lifetime; the workspace capability records the evidence. */
export interface RunChangesPort {
  readonly repo: Pick<RunFileChangesRepo, "summarize">;
  begin(context: ToolRunContext): void;
  beforeWrite(
    context: ToolRunContext,
    path: string,
    expectedRevision?: string,
  ): Promise<BeforeWrite>;
  /** Serializes app-private snapshot admission, writes and cleanup across run owners. */
  withSnapshotLease?<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T>;
  snapshotBudget?: {
    admit(bytes: number, signal: AbortSignal): Promise<void>;
    added(bytes: number): void;
    invalidate(): void;
  };
  /** Persist a recoverable Office before-image and candidate hash before publishing. */
  prepareOfficeWrite?(
    context: ToolRunContext,
    before: BeforeWrite,
    path: string,
    root: string,
    candidate: Uint8Array,
    assertCurrent: () => void,
  ): Promise<string>;
  afterWrite(
    context: ToolRunContext,
    before: BeforeWrite,
    path: string,
    root: string,
    expectedAfterRevision?: string,
  ): Promise<void>;
  watchCommand(context: ToolRunContext, root: string, reconcile?: boolean): Promise<void>;
  touched(runId: string): Promise<string[]>;
  watching(runId: string): boolean;
  finish(context: ToolRunContext): Promise<void>;
}
/** A file one run changed, resolved from that run's own records for a GUI preview. */
export interface TurnFileSource {
  botId: string;
  /** The recorded workspace root (canonical); its identity matched the recorded one. */
  root: string;
  /** The recorded absolute path, still canonical and inside `root`. */
  path: string;
  rootIdentity: { canonicalPath: string; device: string; inode: string };
}
export interface ChangesPort {
  readonly turn: RunChangesPort;
  /**
   * Throws an RpcError (invalidParams: preview_unavailable / preview_changed / preview_missing)
   * unless `path` is a non-deleted file in that run's visible turn changes.
   */
  turnFile(runId: string, path: string, signal: AbortSignal): Promise<TurnFileSource>;
  /** The files one run changed with line counts, as `changes.turn { runId }` returns them. */
  turnFiles(runId: string, signal: AbortSignal): Promise<ChangesTurn>;
  readonly reader: GitReader;
  scope(target: ChangesTarget, signal: AbortSignal): Promise<ChangesScope>;
  forget(root: string): void;
  notify(
    scope: Pick<ChangesScope, "conversationKey" | "topicId">,
    reason?: "files" | "stats" | "review",
  ): void;
  managedConfiguration?: import("./managed-config-port.ts").ManagedBranchConfigurationPort;
  managedLayout?: {
    allows(scope: ChangesScope, signal: AbortSignal): Promise<boolean>;
    write(
      scope: ChangesScope,
      operations: GitWriteOperation[],
      signal: AbortSignal,
    ): Promise<Pick<CommandResult, "exitCode" | "durationMs" | "timedOut" | "stopped">>;
  };
  userWriteLease?: <T>(
    scope: ChangesScope,
    signal: AbortSignal,
    operation: (signal: AbortSignal, assertAuthorized: () => void) => Promise<T>,
  ) => Promise<T>;
  recordFinding(
    context: ToolRunContext,
    prepared: PreparedTool,
    input: {
      path: string;
      line?: number;
      endLine?: number;
      severity: "security" | "bug" | "suggestion";
      message: string;
    },
  ): Promise<LocalToolResult>;
  turnDiff(
    scope: ChangesScope,
    runId: string,
    path: string,
    signal: AbortSignal,
  ): Promise<ChangesDiff>;
  parseStatus(raw: Buffer): {
    branch: string | null;
    head: string | null;
    entries: { path: string; status: string; inHead: boolean }[];
  };
  verifyReceipt(
    receipt: WorktreeReceipt,
    signal: AbortSignal,
    pinGit?: boolean,
  ): Promise<WorktreeReceipt>;
  assertReceipt(receipt: WorktreeReceipt): void;
}
/**
 * A group plan step that writes in its own workspace (maintainers 2026-11-14). The output folder is
 * outside Git (`.pibot` is excluded), so its files are carried into and out of the workspace.
 */
export interface PlanStepWorkspace {
  /** The plan chain's budget root: a replacement plan keeps the same managed folder repository. */
  planKey: string;
  /** The plan's output folder inside the group's primary folder. */
  outputFolder: string;
}
/** Why a writing step takes turns in the shared folder instead (fixed codes only). */
export type StepWorkspaceFallback = { fallback: string };
export type StepMerge =
  | { state: "merged" }
  | { state: "pending" }
  | { state: "conflict"; code: string; files: string[] }
  | { state: "failed"; code: string };
/**
 * Whether a plan step the group's pause stopped can go on in its own workspace (maintainers
 * 2026-11-21): `none` it had none or never started in it; `lost` it had one that cannot be kept.
 */
export type StepKeep =
  | { state: "none" }
  | { state: "lost" }
  | { state: "kept"; worktreeId: string; version: number };
/** Group routing asks only about its current run; it never sees the worktree owner/registry. */
export interface GroupWorktreesPort {
  prepare(
    context: ToolRunContext,
    group: Group,
    signal: AbortSignal,
    step?: PlanStepWorkspace,
  ): Promise<StepWorkspaceFallback | undefined>;
  /** After a fallback: waits until the steps ahead in the same shared folder have ended. */
  waitTurn(context: ToolRunContext, signal: AbortSignal): Promise<void>;
  /** Whether this task's run is still waiting for its turn (it has not started working). */
  waitingTurn(taskId: string): boolean;
  /** A task's isolated checkout and the primary folder it mirrors, for checks inside it. */
  isolated(taskId: string): { root: string; primary: string } | undefined;
  integratedRoot?(taskId: string): { root: string; primary: string } | undefined;
  /** Program merge of a passed plan step under the usual integration policy. */
  mergeStep(taskId: string, signal: AbortSignal): Promise<StepMerge>;
  /** Removes a step's unmerged workspace, keeping its branch (plan ended or step redone). */
  discardStep(taskId: string, signal: AbortSignal): Promise<void>;
  /** Pause-continue: whether the stopped step's workspace, unmerged work intact, can go on. */
  keepStep(taskId: string, botId: string, signal: AbortSignal): Promise<StepKeep>;
  /** Moves a kept workspace to the rerun's task, inside the transaction creating that task. */
  adoptStep(
    fromTaskId: string,
    toTaskId: string,
    kept: Extract<StepKeep, { state: "kept" }>,
  ): boolean;
  /** After adoptStep committed: the workspace's output record follows it (never throws). */
  adoptedStep(fromTaskId: string, toTaskId: string): Promise<void>;
  /** Removes the plan's managed folder repository once no step workspace needs it. */
  endPlan(primaryPath: string, planKey: string): Promise<void>;
  /** Workspaces not yet merged or removed (bounded), for the cleanup sweep. */
  openWorkspaces(): GroupMemberWorkspace[];
  /** Plan keys of Pi Bot's folder repositories present in a local folder (restart cleanup). */
  managedPlanKeys(primaryPath: string): Promise<string[]>;
  workplace(
    context: ToolRunContext,
    group: Group,
    signal: AbortSignal,
  ): ReturnType<typeof groupWorkplace>;
  settled(record: Run): Promise<void>;
  verify(tree: ManagedRecord, signal: AbortSignal): Promise<ManagedGitRepository>;
  workspace(taskId: string): GroupMemberWorkspace | undefined;
  blocksWake(taskId: string): boolean;
  integrateTask(context: ToolRunContext, taskId: string, signal: AbortSignal): Promise<void>;
  cancel(): void;
  dispose(): Promise<void>;
}
export interface ManagedResourcesPort {
  retry<T>(
    target: ChangesTarget,
    /** `files.managed` is false when the working folder cannot be managed: no file restores. */
    action: (scope: ChangesScope, signal: AbortSignal, files: { managed: boolean }) => Promise<T>,
  ): Promise<T>;
  readonly checkpoints: {
    restore(
      input: {
        target: ChangesTarget;
        id: string;
        requestId: string;
        expectedVersion: number;
        itemIds: string[];
      },
      signal: AbortSignal,
    ): Promise<FileRestore>;
  };
  captureDrained(
    context: ToolRunContext | undefined,
    record: Run,
    signal: AbortSignal,
  ): Promise<void>;
  beginBrowserTakeover(botId: string): () => void;
  dispose(): Promise<void>;
}
export interface WorkspaceServices {
  readonly changes: ChangesPort;
  readonly resources: ManagedResourcesPort;
  readonly members: GroupWorktreesPort;
  /** Cancels user management work before the kernel drains its consumers. */
  quiesce(): void;
  /** Invoked only after queue, tool cleanup and request owners have really drained. */
  dispose(): Promise<void>;
}
