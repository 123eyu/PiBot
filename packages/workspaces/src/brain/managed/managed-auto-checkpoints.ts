import { lstatSync, realpathSync } from "node:fs";
import { AgentError } from "@pibot/agent";
import type { WorkspaceLocal as LocalService, ToolRunContext } from "@pibot/brain/kit";
import { intersectTaskPermissions } from "@pibot/brain/kit";
import { fileIdentity } from "@pibot/execution";
import { FileCheckpointsRepo, RunFileChangesRepo } from "@pibot/storage";
import {
  type CheckpointCapture,
  RpcError,
  RpcErrorCodes,
  type Run,
} from "@pibot/workspaces-contract/full";
import type { ChangesScope } from "../changes/changes-scope.ts";
import {
  authorizationSnapshot,
  groupAuthorization,
  resolveRunWorkplace,
  runPermissions,
} from "../runtime.ts";
import { CaptureSkip, captureCheckpoint, captureSkipReason } from "./managed-checkpoint-capture.ts";
import { isManagedCleanupFailure } from "./managed-failure.ts";
import type { ManagedResourcePorts } from "./managed-resource-ports.ts";

const authorityRefusals = new Set([
  "execution_unavailable",
  "Unknown Bot",
  "Unknown topic",
  "Group removed",
  "Unknown working folder",
  "Bot home changed",
  "Bot home cannot be a symbolic link",
  "Working folder changed; associate it again",
  "Group folder changed; associate it again",
  "Group workplace unavailable",
  "Routine workplace removed",
  "topic_workplace_changed",
  "workspace_boundary_changed",
  "workspace_conflict",
  "workspace_primary_missing",
  "task_identity_changed",
  "task_source_changed",
  "task_workplace_changed",
]);

function authorityFailure(error: unknown): never {
  // Only source/root reads use this errno mapping; storage failures must keep the drain rejected.
  if (isManagedCleanupFailure(error)) throw error;
  if (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes(String(error.code))
  )
    throw new CaptureSkip("authority_changed");
  throw error;
}

/** No run.signal here: a stopped run can already have written files that must remain recoverable. */
export async function captureDrainedRun(
  local: LocalService,
  ports: ManagedResourcePorts,
  context: ToolRunContext | undefined,
  record: Run,
  signal: AbortSignal,
) {
  try {
    await capture(local, ports, context, record, signal);
  } catch (error) {
    try {
      local.deps.logger.error(
        `module=managed-auto-checkpoints bot=${record.botId} run=${record.id} reason=checkpoint_capture_failed`,
      );
    } catch {
      // The logger can fail too; the original rejection must still keep the drain unconfirmed.
    }
    throw error;
  }
}

async function capture(
  local: LocalService,
  ports: ManagedResourcePorts,
  context: ToolRunContext | undefined,
  record: Run,
  signal: AbortSignal,
) {
  const db = local.deps.db,
    repo = new FileCheckpointsRepo(db);
  if (
    (context &&
      (record.id !== context.runId ||
        record.botId !== context.botId ||
        record.conversationId !== context.conversationId)) ||
    !record.finishedAt ||
    !["done", "error", "aborted"].includes(record.status)
  )
    throw new Error("Checkpoint drain identity mismatch");
  if (repo.capture(record.id)) return;
  const hasWrites =
    new RunFileChangesRepo(db).summarize(record.id).some((row) => row.kind !== "command") ||
    repo.hasWriteToolEvidence(record.id);
  if (!hasWrites) return;
  // A pre-tool failure has no context. Evidence of a write makes that absence a failed drain.
  if (!context) throw new Error("Checkpoint drain context unavailable");
  let receipt: CheckpointCapture;
  try {
    signal.throwIfAborted();
    const internal = context.executionTaskId
      ? local.tasks.tasks.internal(context.executionTaskId)
      : undefined;
    if (context.executionTaskId && !internal) throw new CaptureSkip("authority_changed");
    const source = {
      ...(internal?.authority.source ?? context),
      signal,
      language: context.language,
    } as ToolRunContext;
    const verifySource = () => {
      if (!internal) return;
      try {
        local.tasks.verifySource(internal.authority, signal);
      } catch (error) {
        authorityFailure(error);
      }
    };
    verifySource();
    local.execution.get({ botId: source.botId, conversationId: source.conversationId as string });
    if (
      source.groupAuthorization !== undefined &&
      groupAuthorization(local, source) !== source.groupAuthorization
    )
      throw new CaptureSkip("authority_changed");
    const place = await resolveRunWorkplace(local, source, signal).catch(authorityFailure);
    if (
      !context.runWorkplace ||
      JSON.stringify({ cwd: place.cwd, boundary: place.boundary }) !==
        JSON.stringify(context.runWorkplace)
    )
      throw new CaptureSkip("authority_changed");
    const root = place.boundary.roots.find((entry) => entry.role === "primary");
    if (!root?.device || !root.inode) throw new CaptureSkip("authority_changed");
    const baseline = authorizationSnapshot(local, source.botId, source);
    const assertAuthorized = () => {
      signal.throwIfAborted();
      if (baseline !== authorizationSnapshot(local, source.botId, source))
        throw new CaptureSkip("authority_changed");
      verifySource();
      try {
        for (const pinned of place.boundary.roots) {
          const info = lstatSync(pinned.canonicalPath, { bigint: true });
          const current = fileIdentity(info);
          // A root recorded without identity (null) never matches.
          if (
            !info.isDirectory() ||
            info.isSymbolicLink() ||
            realpathSync(pinned.canonicalPath) !== pinned.canonicalPath ||
            current.device !== pinned.device ||
            current.inode !== pinned.inode
          )
            throw new CaptureSkip("authority_changed");
        }
      } catch (error) {
        authorityFailure(error);
      }
    };
    const policy = await local.getPolicy(signal);
    const current = runPermissions(local, context);
    const settings = internal
      ? intersectTaskPermissions(internal.authority.permissions, current)
      : current;
    for (const row of new RunFileChangesRepo(db).summarize(record.id)) {
      if (row.kind === "command") continue;
      const result = await policy.evaluate({
        botId: context.botId,
        request: { category: "read_file", path: row.path },
        settings,
        permissionSources: local.permissions.sources(context.botId, context.permissionGroupId),
        workplace: place.value,
        boundary: place.boundary,
        cwd: place.cwd,
        signal,
      });
      if (result.decision === "deny") throw new CaptureSkip("authority_changed");
      assertAuthorized();
    }
    const roots = place.boundary.roots.map((entry) => ({
      id: entry.id,
      name: entry.id,
      path: entry.canonicalPath,
      role: entry.role,
      device: entry.device,
      inode: entry.inode,
    }));
    const primary = roots.find((entry) => entry.role === "primary") as ChangesScope["primary"];
    const scope: ChangesScope = {
      conversationKey: source.groupId ? `group:${source.groupId}` : `dm:${source.botId}`,
      ...(!source.groupId ? { topicId: source.conversationId } : {}),
      botId: context.botId,
      botName: "",
      home: place.home,
      ...(source.groupId ? { groupId: source.groupId } : {}),
      conversationId: source.conversationId,
      roots,
      primary,
      root: primary,
      boundaryConflict: place.boundary.conflict !== "none",
      nestedReadonly: place.boundary.conflict !== "none",
    };
    const written = new Set(
      new RunFileChangesRepo(db)
        .summarize(record.id)
        .filter((r) => r.kind !== "command")
        .map((r) => r.root),
    );
    const receipts: CheckpointCapture[] = [];
    for (const root of roots) {
      if (root.role === "readonly" || !written.has(root.path)) continue;
      receipts.push(
        await captureCheckpoint(
          db,
          ports,
          { ...scope, root },
          record.id,
          assertAuthorized,
          signal,
          false,
        ),
      );
    }
    receipt = receipts.find((r) => r.state === "retained") ??
      receipts[0] ?? { state: "skipped", checkpointId: null, reason: "snapshot_unavailable" };
    repo.saveCapture(record.id, receipt);
  } catch (error) {
    if (isManagedCleanupFailure(error)) throw error;
    let reason = captureSkipReason(error, signal);
    if (local.shutdown.signal.aborted && error === local.shutdown.signal.reason)
      reason = "capture_interrupted";
    if (
      !reason &&
      ((error instanceof RpcError &&
        error.code === RpcErrorCodes.invalidParams &&
        authorityRefusals.has(error.message)) ||
        (error instanceof AgentError &&
          ["task_unavailable", "task_workplace_changed", "workplace_unavailable"].includes(
            error.code,
          )))
    )
      reason = "authority_changed";
    if (!reason) throw error;
    // Admission failure is a visible skipped checkpoint, never permission to retry a stopped tool.
    receipt = {
      state: "skipped",
      checkpointId: null,
      reason,
    };
    repo.saveCapture(record.id, receipt);
  }
  local.approvals.audit.append({
    botId: context.botId,
    runId: record.id,
    kind: "file.checkpoint",
    summary: "Automatic file checkpoint / 自动文件检查点",
    detail: {
      actor: "automatic",
      toolName: "managed.checkpoint_create",
      reasonCode: receipt.reason ?? "retained",
    },
  });
  local.deps.peer.emit("changes.changed", { runId: record.id, reason: "turn" });
}
