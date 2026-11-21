import { AgentError, agentHttpStatus, mapAgentError } from "../core/errors.ts";

// Refresh endpoints also use HTTP 400 for a revoked/rotated refresh token.
// Inspect only known codes; raw SDK response bodies must never leave agent.
function invalidRefreshToken(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  const item = error as { code?: unknown; message?: unknown; cause?: unknown };
  const terminal =
    /\b(?:invalid_grant|invalid_refresh_token|refresh_token_(?:reused|expired|revoked|invalidated)|token_revoked)\b/i;
  return (
    (typeof item.code === "string" && terminal.test(item.code)) ||
    (typeof item.message === "string" && terminal.test(item.message)) ||
    invalidRefreshToken(item.cause, seen)
  );
}

function timedOut(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  const item = error as { name?: unknown; message?: unknown; cause?: unknown };
  return (
    item.name === "TimeoutError" ||
    (typeof item.message === "string" && /\bTimeoutError\b/.test(item.message)) ||
    timedOut(item.cause, seen)
  );
}

export function oauthRefreshError(error: unknown, signal: AbortSignal): AgentError {
  if (signal.aborted)
    return new AgentError(signal.reason?.name === "TimeoutError" ? "network" : "aborted");
  if (timedOut(error)) return new AgentError("network");
  const status = agentHttpStatus(error);
  const code = mapAgentError(error);
  if (code.startsWith("proxy_")) return new AgentError(code);
  if (
    status === 401 ||
    status === 403 ||
    ((status === undefined || status === 400) && invalidRefreshToken(error))
  )
    return new AgentError("auth_failed", status);
  // A generic SDK "authentication failed" is not proof that user credentials
  // were rejected: malformed responses and upstream outages need another try.
  return new AgentError(
    code === "auth_failed" || code === "internal" ? "provider_error" : code,
    status,
  );
}
