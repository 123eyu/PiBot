import type { Logger } from "@pibot/observability";
// Subpath: the early window imports this before the protocol schemas are evaluated.
import { RpcError } from "@pibot/protocol/background";

export function externalUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("Unsupported external URL protocol");
  }
  if (url.username || url.password) throw new TypeError("URL credentials are not allowed");
  return url.href;
}

export async function openExternalUrl(
  value: string,
  open: (url: string) => Promise<void>,
  logger: Logger,
): Promise<void> {
  try {
    const url = externalUrl(value);
    // URL paths, queries and raw OS errors may contain user content or credentials.
    logger.info("audit host.openExternal requested");
    await open(url);
    logger.info("audit host.openExternal completed");
  } catch (error) {
    logger.warn("external link open failed or blocked");
    if (error instanceof RpcError) throw error;
    throw new Error("External link unavailable");
  }
}
