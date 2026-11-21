import { ExecError } from "../core/types.ts";
import { SearchHttpError } from "./search-http.ts";

export type KeylessFailure = "unavailable" | "structure" | "dns_blocked";

/** Only actual connectivity failures may trigger another recipient, not unsafe/large responses. */
export function keylessFailure(error: unknown): KeylessFailure {
  // DNS answered with a loopback/private address (filtering DNS or a hosts entry). The address
  // check still refuses to connect; this only names the cause, so the other provider can be tried
  // and the model is not told the page changed. "structure" stays reserved for parse failures.
  if (error instanceof ExecError && error.reason === "private_address") return "dns_blocked";
  if (error instanceof SearchHttpError)
    return error.reason === "network" ? "unavailable" : "structure";
  if (
    error instanceof Error &&
    "code" in error &&
    [
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNRESET",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "UND_ERR_SOCKET",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
    ].includes(String(error.code))
  )
    return "unavailable";
  return "structure";
}
