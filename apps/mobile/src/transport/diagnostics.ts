import {
  type DirectDiagnostic,
  DirectDiagnosticSchema,
  NoiseHandshakeError,
  type PathEvent,
} from "@pibot/link";

/** Own error codes only (snake_case); anything else may carry addresses or keys. */
const FIXED_CODE = /^[a-z][a-z0-9_]{2,60}$/;
export const fixedCode = (value: unknown) =>
  typeof value === "string" && FIXED_CODE.test(value) ? value : undefined;

// Node dev probes have no __DEV__ and log everything, like a development build.
const DEV = typeof __DEV__ === "undefined" || __DEV__;

/** Phone link lifecycle (opened / closed with reason and duration, path changes), fixed codes. */
export function reportLinkEvent(event: string, fields: Record<string, string | number> = {}) {
  const safe: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(fields))
    if (typeof value === "number" ? Number.isFinite(value) : fixedCode(value)) safe[key] = value;
  console.info(JSON.stringify({ module: "mobile-link", event, ...safe }));
}
export function reportPathEvent({ event, ...fields }: PathEvent) {
  // path_selected already says the path is up; the keepalive starting with it is dev detail.
  if (!DEV && event === "keepalive_on") return;
  // Path, pair kind, probe results, loss reasons and traffic counts: fixed codes and numbers
  // only, and reportLinkEvent drops anything else.
  reportLinkEvent(event, fields as Record<string, string | number>);
}

const STATE_EVENTS = new Set(["ice", "connection", "gathering", "channel"]);
const TROUBLE_STATES = new Set(["disconnected", "failed", "error"]);
/**
 * Release builds keep what explains a direct attempt: candidates, signaling counts, failures and
 * direct_ready with its time. Each step of the WebRTC state machines (about a dozen lines per
 * attempt, 2026-11-14 phone log) is development-only unless it is a disconnect or failure.
 */
function quietInRelease(event: DirectDiagnostic) {
  return (
    !DEV && STATE_EVENTS.has(event.event) && "state" in event && !TROUBLE_STATES.has(event.state)
  );
}
export function reportDirectDiagnostic(event: DirectDiagnostic) {
  const parsed = DirectDiagnosticSchema.safeParse(event);
  if (parsed.success && !quietInRelease(parsed.data))
    console.info(JSON.stringify({ module: "mobile-direct", ...parsed.data }));
}

/** The release phone has no remote console; log only fixed codes usable in local logcat. */
export function reportLinkFailure(error: unknown, stage: "link" | "session") {
  if (error instanceof NoiseHandshakeError && error.phase === "cancelled") return;
  const reason =
    error instanceof NoiseHandshakeError
      ? "handshake_failed"
      : error instanceof Error && error.message === "remote_room_empty"
        ? "room_empty"
        : error instanceof Error && error.message === "remote_session_timeout"
          ? "session_timeout"
          : error instanceof Error && error.message === "drain_unconfirmed"
            ? "drain_unconfirmed"
            : error instanceof ReferenceError
              ? "reference_error"
              : error instanceof TypeError
                ? "type_error"
                : error instanceof Error && error.message === "relay_unavailable"
                  ? "relay_unavailable"
                  : "connection_failed";
  // The generic bucket hid every cause (14 per 10 min on the owner's phone, 2026-11-11): keep the
  // own fixed code when there is one.
  const code =
    reason === "connection_failed" && error instanceof Error ? fixedCode(error.message) : undefined;
  console.warn(
    JSON.stringify({
      module: "mobile-link",
      event: "connection_failed",
      stage,
      reason,
      ...(code ? { code } : {}),
      ...(error instanceof NoiseHandshakeError ? { phase: error.phase } : {}),
    }),
  );
  return reason;
}
