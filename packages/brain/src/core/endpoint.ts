import { RpcError } from "@pibot/protocol-base";

/** A configured service base URL: http(s) only, no credentials, query or fragment, no trailing slash. */
export function endpoint(value: string): string {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new RpcError(-32602, "invalid_endpoint");
  return url.href.replace(/\/$/, "");
}
