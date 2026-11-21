import {
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import type { ConnectorConnectionOptions } from "@pibot/protocol-base";
import { TOOL_CALL_ID_REQUEST_META_KEY } from "./adapter/utils.ts";
import { boundedMcpResponse } from "./bounded-json-response.ts";
import { createConnectorOAuthProvider } from "./oauth.ts";

const RESUMED_STREAM_TIMEOUT_MS = 5 * 60_000;

export async function createHttpTransport(
  options: Extract<ConnectorConnectionOptions, { transport: "http" }>,
  setAuthFailure: (value: boolean) => void,
  kind: "streamable" | "sse",
  callSignals: ReadonlyMap<string, AbortSignal>,
): Promise<Transport> {
  const transportOptions = {
    requestInit: { headers: { ...options.headers } },
    ...(options.oauth ? { authProvider: await createConnectorOAuthProvider(options.oauth) } : {}),
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const get = (init?.method ?? "GET").toUpperCase() === "GET";
      const persistent = get && headers.get("accept")?.includes("text/event-stream") === true;
      const resumed = get && headers.has("last-event-id");
      const signal = AbortSignal.any([
        options.signal,
        ...(resumed
          ? [AbortSignal.timeout(RESUMED_STREAM_TIMEOUT_MS)]
          : persistent
            ? []
            : [AbortSignal.timeout(30_000)]),
        ...(init?.signal ? [init.signal] : []),
      ]);
      const response = await fetch(url, { ...init, signal });
      if (new URL(url.toString()).origin === new URL(options.url).origin)
        setAuthFailure(response.status === 401 || response.status === 403);
      return boundedMcpResponse(response, signal);
    },
  };
  const transport: Transport =
    kind === "sse"
      ? new SSEClientTransport(new URL(options.url), transportOptions)
      : new StreamableHTTPClientTransport(new URL(options.url), transportOptions);
  const send = transport.send.bind(transport);
  transport.send = (message, sendOptions) => {
    const meta =
      "method" in message && message.method === "tools/call" ? message.params?._meta : undefined;
    const callId =
      meta && typeof meta === "object"
        ? (meta as Record<string, unknown>)[TOOL_CALL_ID_REQUEST_META_KEY]
        : undefined;
    const signal = typeof callId === "string" ? callSignals.get(callId) : undefined;
    // 2.3.1 omits requestSignal for legacy peers. The public transport option is still honored
    // by the POST body, resume GET and reconnect scheduler, without closing concurrent calls.
    return send(
      message,
      signal
        ? {
            ...sendOptions,
            requestSignal: AbortSignal.any([
              signal,
              ...(sendOptions?.requestSignal ? [sendOptions.requestSignal] : []),
            ]),
          }
        : sendOptions,
    );
  };
  return transport;
}
