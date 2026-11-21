import { ExecError } from "../core/types.ts";
import { isProxyUnavailable } from "./network-proxy.ts";

/** Only emit fixed categories, never network messages, URLs, headers or response contents. */
export function webFailure(error: unknown, fallback: NonNullable<ExecError["reason"]>) {
  if (error instanceof ExecError) return error;
  if (isProxyUnavailable(error)) return new ExecError("web_failed", "proxy_unavailable");
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current; depth++) {
    const record = current as { code?: unknown; cause?: unknown };
    const code = typeof record.code === "string" ? record.code : "";
    if (["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL"].includes(code))
      return new ExecError("web_failed", "dns_failed");
    if (code === "UND_ERR_INVALID_ARG")
      return new ExecError("web_failed", "dispatcher_incompatible");
    if (/^(?:CERT_|ERR_TLS_|DEPTH_ZERO_|UNABLE_TO_|SELF_SIGNED_)/.test(code))
      return new ExecError("web_failed", "tls_failed");
    if (
      ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"].includes(code)
    )
      return new ExecError("web_failed", "timeout");
    if (["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH"].includes(code))
      return new ExecError("web_failed", "connection_failed");
    current = record.cause;
  }
  return new ExecError("web_failed", fallback);
}
