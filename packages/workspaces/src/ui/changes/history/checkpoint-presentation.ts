import type { TranslationKey } from "@pibot/i18n";
import type { CheckpointCapture, FileRestore } from "@pibot/workspaces-contract/full";

export function checkpointNotice(
  capture: CheckpointCapture | undefined,
  pending: boolean,
  hasFiles: boolean,
): TranslationKey | undefined {
  if (capture?.state === "skipped") return `checkpoint.skip.${capture.reason}`;
  if (capture?.state === "retained") return undefined;
  if (pending) return "checkpoint.waitForRun";
  return hasFiles ? "checkpoint.noReceipt" : "checkpoint.noFiles";
}
export const restoreSettled = (value: FileRestore) =>
  ["done", "conflict", "interrupted"].includes(value.state);
export const restoreCanResume = (value: FileRestore) => value.state === "interrupted";
export function restoreStatus(value: FileRestore): TranslationKey {
  switch (value.state) {
    case "intent":
      return "agentWork.restoreIntent";
    case "running":
      return "agentWork.restoreRunning";
    case "done":
      return "checkpoint.done";
    case "conflict":
      return "checkpoint.conflict";
    case "interrupted":
      return "checkpoint.interrupted";
  }
}
export function restoreItemStatus(item: FileRestore["items"][number]): TranslationKey {
  if (item.state === "restored") return "agentWork.fileRestored";
  if (item.reason) return `checkpoint.restoreReason.${item.reason}`;
  switch (item.state) {
    case "conflict":
      return "checkpoint.fileConflictUnknown";
    case "interrupted":
      return "agentWork.fileInterrupted";
    case "pending":
      return "agentWork.filePending";
  }
}

/** Events may finish after an older metadata read; keep the newest observed journal state. */
export function mergeRestoreReceipts(
  current: readonly FileRestore[],
  incoming: readonly FileRestore[],
) {
  const merged = new Map(current.map((value) => [value.id, value]));
  for (const value of incoming) {
    const old = merged.get(value.id);
    if (!old || old.updatedAt <= value.updatedAt) merged.set(value.id, value);
  }
  return [...merged.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, 100);
}
