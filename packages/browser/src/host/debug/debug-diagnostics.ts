import { randomUUID } from "node:crypto";
import { type BrowserDiagnostics, BrowserDiagnosticsSchema } from "@pibot/browser-contract/full";
import { z } from "zod";
import type { Cdp } from "../cdp.ts";

const remote = z.object({ type: z.string(), value: z.unknown().optional() });
const consoleEvent = z.object({ type: z.string(), args: z.array(remote).max(100) });
const exceptionEvent = z.object({
  exceptionDetails: z.object({
    text: z.string(),
    exception: z.object({ description: z.string().optional() }).optional(),
  }),
});
const requestEvent = z.object({ requestId: z.string(), request: z.object({ url: z.string() }) });
const responseEvent = z.object({
  requestId: z.string(),
  response: z.object({ status: z.number(), url: z.string() }),
});
const failureEvent = z.object({ requestId: z.string(), errorText: z.string() });
const doneEvent = z.object({ requestId: z.string() });

export function safeDebugUrl(value: string) {
  try {
    const url = new URL(value);
    return /^(?:https?|wss?):$/.test(url.protocol)
      ? `${url.protocol}//${url.host}${url.pathname}`.slice(0, 1024)
      : "[non-http URL]";
  } catch {
    return "[invalid URL]";
  }
}
export function debugText(value: string, redact: (text: string) => string) {
  return redact(
    value
      .slice(0, 4096)
      .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, safeDebugUrl)
      .replace(/\p{Cc}/gu, " "),
  ).slice(0, 1024);
}

/** In-memory, run-scoped metadata only; remote objects and request bodies are never read. */
export function createBrowserDiagnostics(
  cdp: Cdp,
  options: { enabled(): boolean; redact(text: string): string },
) {
  let documentId = randomUUID();
  let nextSeq = 0;
  let supported = true;
  let wasEnabled = false;
  const entries: BrowserDiagnostics["entries"] = [];
  const requests = new Map<string, string>();
  const reset = () => {
    documentId = randomUUID();
    entries.length = 0;
    requests.clear();
  };
  const enabled = () => {
    const on = options.enabled();
    if (on !== wasEnabled) {
      reset();
      wasEnabled = on;
    }
    return on;
  };
  const add = (entry: Omit<BrowserDiagnostics["entries"][number], "seq">) => {
    if (!enabled()) return;
    entries.push({ ...entry, seq: ++nextSeq });
    while (
      entries.length > 100 ||
      entries.reduce((n, item) => n + item.text.length + (item.url?.length ?? 0), 0) > 32768
    )
      entries.shift();
  };
  const text = (value: string) => debugText(value, options.redact);
  const off = [
    cdp.on("Runtime.consoleAPICalled", (raw) => {
      if (!enabled()) return;
      const p = consoleEvent.safeParse(raw);
      if (!p.success || !["warning", "error", "assert"].includes(p.data.type)) return;
      add({
        kind: "console",
        level: p.data.type === "warning" ? "warning" : "error",
        text: text(
          p.data.args
            .slice(0, 10)
            .map((arg) =>
              arg.type === "string" && typeof arg.value === "string" ? arg.value : `[${arg.type}]`,
            )
            .join(" "),
        ),
      });
    }),
    cdp.on("Runtime.exceptionThrown", (raw) => {
      if (!enabled()) return;
      const p = exceptionEvent.safeParse(raw);
      if (p.success)
        add({
          kind: "exception",
          level: "error",
          text: text(
            p.data.exceptionDetails.exception?.description?.split("\n")[0] ??
              p.data.exceptionDetails.text,
          ),
        });
    }),
    cdp.on("Network.requestWillBeSent", (raw) => {
      if (!enabled()) return;
      const p = requestEvent.safeParse(raw);
      if (!p.success) return;
      if (requests.size >= 256) requests.delete(requests.keys().next().value as string);
      requests.set(p.data.requestId, text(safeDebugUrl(p.data.request.url)));
    }),
    cdp.on("Network.responseReceived", (raw) => {
      if (!enabled()) return;
      const p = responseEvent.safeParse(raw);
      if (!p.success || !requests.has(p.data.requestId) || p.data.response.status < 400) return;
      add({
        kind: "network",
        level: "error",
        text: `HTTP ${p.data.response.status}`,
        status: Math.trunc(p.data.response.status),
        url: text(safeDebugUrl(p.data.response.url)),
      });
    }),
    cdp.on("Network.loadingFailed", (raw) => {
      if (!enabled()) return;
      const p = failureEvent.safeParse(raw);
      if (!p.success || !requests.has(p.data.requestId)) return;
      add({
        kind: "network",
        level: "error",
        text: text(p.data.errorText),
        url: requests.get(p.data.requestId),
      });
      requests.delete(p.data.requestId);
    }),
    cdp.on("Network.loadingFinished", (raw) => {
      const p = doneEvent.safeParse(raw);
      if (p.success) requests.delete(p.data.requestId);
    }),
  ];
  const ready = cdp
    .send("Network.enable", { maxTotalBufferSize: 1048576, maxResourceBufferSize: 65536 })
    .catch(() => {
      supported = false;
    });
  return {
    get documentId() {
      enabled();
      return documentId;
    },
    reset,
    async read(after = 0, limit = 20): Promise<BrowserDiagnostics> {
      await ready;
      enabled();
      return BrowserDiagnosticsSchema.parse({
        documentId,
        supported,
        oldestSeq: entries[0]?.seq ?? nextSeq + 1,
        nextSeq,
        dropped: after > 0 && after < (entries[0]?.seq ?? nextSeq + 1) - 1,
        entries: entries.filter((item) => item.seq > after).slice(0, limit),
      });
    },
    dispose() {
      for (const remove of off) remove();
      reset();
    },
  };
}
