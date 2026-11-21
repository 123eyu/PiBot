import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { MobileKey } from "../i18n/messages.ts";

export function errorKey(error: unknown): MobileKey {
  const folderErrors: Record<string, MobileKey> = {
    runner_target_offline: "runnerFolderOffline",
    runner_disconnected: "runnerFolderOffline",
    capability_off: "runnerFolderCapabilityOff",
    endpoint_capability_off: "runnerFolderCapabilityOff",
    runner_folder_unreadable: "runnerFolderUnreadable",
    runner_folder_invalid: "runnerFolderUnreadable",
    workspace_targets_mixed: "runnerFolderMixed",
    runner_writable_unsupported: "runnerFolderMixed",
  };
  const folderError = error instanceof Error ? folderErrors[error.message] : undefined;
  if (folderError) return folderError;
  if (error instanceof RpcError) {
    if (error.code === RpcErrorCodes.busy) return "busy";
    if (error.code === RpcErrorCodes.botNameTaken) return "nameTaken";
    if (error.code === RpcErrorCodes.closed) return "offline";
    if (error.code === RpcErrorCodes.invalidParams) return "stale";
    if (error.code === RpcErrorCodes.timeout) return "uncertain";
    // An older computer whose phone whitelist predates a control refuses it as unknown.
    if (error.code === RpcErrorCodes.methodNotFound) return "unsupported";
    if (error.code === RpcErrorCodes.unsupported) return "desktopOnly";
  }
  const code = error instanceof Error ? error.message : "";
  if (code === "link_unavailable") return "unavailable";
  if (code === "drain_unconfirmed") return "busy";
  if (code === "forget_failed") return "forgetFailed";
  if (code === "invalid") return "invalid";
  if (code === "push_unavailable") return "pushUnavailable";
  if (code === "invalid_time") return "invalidTime";
  if (code === "offline") return "actionsOffline";
  if (code === "outbox_full") return "outboxFull";
  if (code === "outbox_files_full") return "attachOutboxFull";
  if (code === "attachments_too_large") return "attachTooLarge";
  if (code === "busy") return "busy";
  if (code === "device_limit") return "deviceLimit";
  if (code === "approval_changed") return "stale";
  if (code === "restore_unavailable") return "restoreUnavailable";
  if (code === "native_cancelled") return "denied";
  if (code === "native_unavailable") return "nativeUnavailable";
  if (code === "unlock_denied") return "denied";
  if (code === "unlock_unavailable") return "unlockUnavailable";
  if (code === "unlock_locked") return "unlockLocked";
  if (code === "notify_denied") return "notifyDenied";
  return "failed";
}
export const unlockCancelled = (error: unknown) =>
  error instanceof Error && error.message === "unlock_cancelled";
