import { fetch, ProxyAgent, type RequestInit } from "undici";

/** All authenticated requests use the connector's authenticated sandbox proxy, never a fallback. */
export function createOAuthHttp(proxy: string) {
  const dispatcher = new ProxyAgent(proxy);
  return {
    close: () => dispatcher.destroy(),
    async json(
      url: string,
      init: RequestInit,
      signal: AbortSignal,
    ): Promise<Record<string, unknown>> {
      const target = new URL(url);
      if (
        target.protocol !== "https:" ||
        !["gmail.googleapis.com", "oauth2.googleapis.com", "auth.pibot.space"].includes(
          target.hostname,
        )
      )
        throw new Error("gmail_network_domain_denied");
      const response = await fetch(target, {
        ...init,
        signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        dispatcher,
        redirect: "error",
      });
      try {
        if (!response.ok) throw new Error("gmail_http_failed");
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (response.body) {
          for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > 2 * 1024 * 1024) throw new Error("gmail_response_limit");
            chunks.push(chunk);
          }
        }
        if (size === 0) return {};
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("gmail_response_invalid");
        return value as Record<string, unknown>;
      } finally {
        await response.body?.cancel().catch(() => undefined); // Release unread error/oversize bodies.
      }
    },
  };
}

export function stringField(value: Record<string, unknown>, key: string, max = 8192): string {
  const result = value[key];
  if (typeof result !== "string" || !result || result.length > max)
    throw new Error("gmail_response_invalid");
  return result;
}
