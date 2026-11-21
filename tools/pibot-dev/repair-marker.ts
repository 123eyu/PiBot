import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AcpDispatchIdentity } from "./acp-client.ts";
import { store } from "./context.ts";
import type { TaskRecord } from "./state.ts";

const pathOf = (id: string) => {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("repair_task_identity_invalid");
  return join(store.dir, "repair-drains", `${id}.json`);
};
/** Only the same dispatch can clear its marker; a new session is not proof the old run drained. */
export function assertRepairRecoverable(task: TaskRecord) {
  try {
    lstatSync(pathOf(task.id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("repair_metadata_unavailable");
  }
  throw new Error("repair_cleanup_unconfirmed");
}
export function markRepairDispatched(task: TaskRecord, dispatch: AcpDispatchIdentity) {
  mkdirSync(join(store.dir, "repair-drains"), { recursive: true });
  writeFileSync(
    pathOf(task.id),
    JSON.stringify({
      taskId: task.id,
      worktree: task.worktree,
      ...dispatch,
      state: "cleanup_unconfirmed",
    }),
    { flag: "wx", mode: 0o600 },
  );
}
export function clearSettledRepair(task: TaskRecord, dispatch: AcpDispatchIdentity) {
  const path = pathOf(task.id);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let saved: Record<string, unknown>;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192) throw new Error("repair_cleanup_unconfirmed");
    saved = JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
  if (
    saved.taskId !== task.id ||
    saved.worktree !== task.worktree ||
    saved.dispatchId !== dispatch.dispatchId ||
    saved.sessionId !== dispatch.sessionId ||
    saved.botId !== dispatch.botId ||
    (saved.targetKind !== undefined && saved.targetKind !== dispatch.targetKind) ||
    (saved.groupId !== undefined && saved.groupId !== dispatch.groupId)
  )
    throw new Error("repair_cleanup_unconfirmed");
  rmSync(path);
}

/** Enrich only this dispatch with fixed owner identity; the full run set lives in task metadata. */
export function recordRepairGroup(
  task: TaskRecord,
  dispatch: AcpDispatchIdentity,
  group: {
    groupId: string;
    topicId: string;
    cycleId: string;
    budgetRootRunId: string;
  },
) {
  const path = pathOf(task.id);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let saved: Record<string, unknown>;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192) throw new Error("repair_cleanup_unconfirmed");
    saved = JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
  if (
    saved.dispatchId !== dispatch.dispatchId ||
    saved.sessionId !== dispatch.sessionId ||
    saved.taskId !== task.id ||
    saved.worktree !== task.worktree ||
    saved.groupId !== group.groupId
  )
    throw new Error("repair_cleanup_unconfirmed");
  const pending = `${path}.${dispatch.dispatchId}.tmp`;
  writeFileSync(
    pending,
    JSON.stringify({
      ...saved,
      group: {
        groupId: group.groupId,
        topicId: group.topicId,
        cycleId: group.cycleId,
        budgetRootRunId: group.budgetRootRunId,
      },
    }),
    { flag: "wx", mode: 0o600 },
  );
  try {
    renameSync(pending, path);
  } finally {
    rmSync(pending, { force: true });
  }
}
