/*
 * Which failures may leave the app, and under what name. An ACP client only shows what it
 * is given, and the dev harness branches on `data.code`; an internal message can quote a path, a
 * prompt or provider text, so anything outside this fixed vocabulary becomes a plain internal
 * error. Without this the SDK's generic handler turned every business refusal into "Internal
 * error" (in review, a quota refusal arrived as a bug and the client then opened a new topic).
 */
import { RequestError } from "@agentclientprotocol/sdk";

/** Fixed `data.code` values an ACP client may branch on. */
export const acpFailureCode = {
  cancelled: "cancelled",
  /** The session (or the topic it continues) is gone: the only case a caller may start anew. */
  sessionNotFound: "session_not_found",
  /** Another connection holds this session; retrying later is the point. */
  sessionBusy: "session_busy",
  /** This connection already holds as many sessions as it may. */
  sessionCapacity: "session_capacity",
  botMissing: "bot_missing",
  groupUnsupported: "group_unsupported",
  groupUnavailable: "group_unavailable",
  groupBusy: "group_busy",
  groupCleanupUnconfirmed: "group_cleanup_unconfirmed",
  groupOutputCapacity: "group_output_capacity",
  topicUnavailable: "topic_unavailable",
  folderUnavailable: "folder_unavailable",
  /** The person's working-folder list is full; only they can remove one. */
  folderCapacity: "folder_capacity",
  workspaceConflict: "workspace_conflict",
  interactiveClientUnavailable: "interactive_client_unavailable",
} as const;

export type AcpFailureCode = (typeof acpFailureCode)[keyof typeof acpFailureCode];

/**
 * One code and message per failure: fixed on purpose, so a client can match them and so no
 * runtime text (paths, prompts) can reach an editor's error banner.
 */
const fixed: Record<AcpFailureCode, { code: number; message: string }> = {
  cancelled: { code: -32800, message: "Request cancelled" },
  session_not_found: { code: -32602, message: "Unknown ACP session" },
  session_busy: { code: -32011, message: "ACP session is already open" },
  session_capacity: { code: -32011, message: "ACP session capacity exceeded" },
  group_unsupported: { code: -32601, message: "ACP groups are unavailable" },
  group_unavailable: { code: -32602, message: "ACP group is unavailable" },
  group_busy: { code: -32011, message: "ACP group is busy" },
  group_cleanup_unconfirmed: { code: -32603, message: "ACP group cleanup is unconfirmed" },
  group_output_capacity: { code: -32603, message: "ACP group output capacity exceeded" },
  bot_missing: { code: -32602, message: "Unknown Bot" },
  topic_unavailable: { code: -32602, message: "Topic is no longer available" },
  folder_unavailable: { code: -32602, message: "Working folder is unavailable" },
  folder_capacity: { code: -32602, message: "Too many working folders" },
  workspace_conflict: { code: -32602, message: "Working folders conflict" },
  interactive_client_unavailable: { code: -32603, message: "Pi Bot has no interactive client" },
};

const of = (name: AcpFailureCode) =>
  new RequestError(fixed[name].code, fixed[name].message, { code: name });

/** The caller cancelled this request; nothing was done and nothing should be retried. */
export const acpCancelled = (): RequestError => of(acpFailureCode.cancelled);

/**
 * Every message allowed to leave the app, mapped to what it means for a client. This is an
 * allowlist on purpose, and a Map on purpose: a message shaped like an identifier does not prove
 * it is a business code (an internal error can look exactly like one), and a plain object would
 * answer for `constructor` or `toString`. Each string is one the brain or this package throws
 * today — a new one belongs here explicitly, with a fixed code, not by pattern.
 */
const refusals = new Map<string, AcpFailureCode>([
  ["acp_group_unsupported", "group_unsupported"],
  ["acp_group_model_unsupported", "group_unsupported"],
  ["acp_target_ambiguous", "group_unavailable"],
  ["acp_group_unavailable", "group_unavailable"],
  ["group_acp_unavailable", "group_unavailable"],
  ["group_acp_topic_required", "group_unavailable"],
  ["group_acp_topic_unavailable", "group_unavailable"],
  ["group_acp_source_changed", "group_unavailable"],
  ["group_acp_roots_changed", "folder_unavailable"],
  ["group_acp_folder_invalid", "folder_unavailable"],
  ["group_acp_capacity", "group_busy"],
  ["group_acp_cycle_busy", "group_busy"],
  ["group_topic_busy", "group_busy"],
  ["group_topic_stale", "group_unavailable"],
  ["group_cleanup_unconfirmed", "group_cleanup_unconfirmed"],
  ["group_output_capacity", "group_output_capacity"],
  // This package's own refusals.
  ["ACP session is busy", "session_busy"],
  ["ACP session is already open", "session_busy"],
  ["ACP session is open", "session_busy"],
  ["ACP session capacity exceeded", "session_capacity"],
  ["ACP session topic is unavailable", "session_not_found"],
  // A load whose topic the person deleted cannot continue; only then may a caller start anew.
  ["Unknown ACP session", "session_not_found"],
  ["Unknown topic", "session_not_found"],
  ["topic_not_found", "session_not_found"],
  // Bot and mode refusals (brain `core/permissions.ts`, `resources/workplaces/*`).
  ["Unknown Bot", "bot_missing"],
  ["Unknown active Bot", "bot_missing"],
  ["Unknown Bot mode", "bot_missing"],
  ["bot_not_found", "bot_missing"],
  // Folders: the person has to move or remove something before this session can run.
  ["Invalid folder", "folder_unavailable"],
  ["Not a directory", "folder_unavailable"],
  ["Unknown working folder", "folder_unavailable"],
  ["workplace_folder_missing", "folder_unavailable"],
  ["runner_folder_invalid", "folder_unavailable"],
  ["Working folder changed; associate it again", "folder_unavailable"],
  ["Group folder unavailable", "folder_unavailable"],
  ["Group workplace unavailable", "folder_unavailable"],
  ["Group file location changed or unavailable", "folder_unavailable"],
  ["Too many working folders", "folder_capacity"],
  // ACP sessions register their folders in their own pool (storage `requireRegistrationRoom`); it
  // fills up while the person's own list still has room, and it means the same: remove one first.
  ["Too many session working folders", "folder_capacity"],
  ["Group folder limit", "folder_capacity"],
  // Overlapping or moved roots; re-associating the same folders cannot fix this.
  ["workspace_conflict", "workspace_conflict"],
  ["workspace_boundary_changed", "workspace_conflict"],
  ["workspace_primary_missing", "workspace_conflict"],
  ["workspace_targets_mixed", "workspace_conflict"],
  ["protected_path", "workspace_conflict"],
  ["managed_root_changed", "workspace_conflict"],
  // A topic that exists but cannot host this session; the client keeps its session id.
  ["topic_archived", "topic_unavailable"],
  ["topic_wrong_bot", "topic_unavailable"],
  ["topic_folder_mismatch", "topic_unavailable"],
  ["topic_workplace_changed", "topic_unavailable"],
]);

const isAbort = (error: unknown) => (error as { name?: unknown } | null)?.name === "AbortError";

/**
 * Maps anything thrown by a handler to the error an ACP client may see. A `RequestError` is kept
 * (a failed run already carries its own code the harness understands); everything unlisted is
 * reported as a redacted internal error.
 */
export function acpFailure(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  // rpc code -32001: Pi Bot's brain has no attached GUI, so interactive work is refused rather
  // than broken. The caller waits for a window instead of failing the task.
  if (code === -32001) return of(acpFailureCode.interactiveClientUnavailable);
  if (isAbort(error)) return of(acpFailureCode.cancelled);
  // rpc codes the brain uses for capacity and for a caller-cancelled run.
  if (code === -32011) return of(acpFailureCode.sessionBusy);
  if (code === -32032) return of(acpFailureCode.cancelled);
  const message = error instanceof Error ? error.message : "";
  const named = refusals.get(message);
  if (named) return of(named);
  return new RequestError(-32603, "Internal error");
}
