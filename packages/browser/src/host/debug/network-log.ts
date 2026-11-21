import { BrowserNetworkEntrySchema, type BrowserNetworkSchema } from "@pibot/browser-contract/full";
import type { z } from "zod";
import { z as schema } from "zod";
import type { Cdp } from "../cdp.ts";
import { createExtraInfo } from "./network-extra.ts";
import { bodyMime, createNetworkMask } from "./network-mask.ts";

const headers = schema.record(schema.string(), schema.string());
const request = schema.object({
  requestId: schema.string(),
  timestamp: schema.number(),
  type: schema.string().optional(),
  redirectHasExtraInfo: schema.boolean().optional(),
  redirectResponse: schema
    .object({ status: schema.number(), headers, mimeType: schema.string() })
    .optional(),
  request: schema.object({ method: schema.string(), url: schema.string().url(), headers }),
});
const response = schema.object({
  requestId: schema.string(),
  timestamp: schema.number(),
  type: schema.string(),
  hasExtraInfo: schema.boolean().optional(),
  response: schema.object({ status: schema.number(), headers: headers, mimeType: schema.string() }),
});
const finished = schema.object({
  requestId: schema.string(),
  timestamp: schema.number(),
  encodedDataLength: schema.number(),
});
export const textMime = bodyMime;
type Entry = z.infer<typeof BrowserNetworkEntrySchema>;

export function createNetworkLog(cdp: Cdp, enabled: () => boolean, redact: (s: string) => string) {
  const mask = createNetworkMask(redact);
  let seq = 0;
  let generation = 0;
  let active = false;
  let previews = 0;
  const entries: Entry[] = [];
  const pending = new Map<string, { entry: Entry; start: number; mime: string; site: string }>();
  const extra = createExtraInfo<typeof pending extends Map<string, infer T> ? T : never>(
    (item, key, headers) => {
      item.entry[key] = Object.fromEntries(
        Object.entries({ ...item.entry[key], ...mask.headers(headers, item.site) }).slice(0, 64),
      );
    },
  );
  const invalidate = (raw: unknown) => {
    const id = schema.object({ requestId: schema.string() }).safeParse(raw);
    if (id.success) extra.invalidate(id.data.requestId);
    else extra.stop();
  };
  const reset = () => {
    generation++;
    entries.length = 0;
    pending.clear();
    extra.clear();
    mask.clear();
  };
  const on = () => {
    const next = enabled();
    if (next !== active) {
      // Retain the masked ring between runs so the debug pane can inspect it after a run ends.
      // Takeover and navigation explicitly reset the document buffer.
      generation++;
      pending.clear();
      extra.clear();
      active = next;
    }
    return next;
  };
  const off = [
    cdp.on("Network.requestWillBeSent", (raw) => {
      if (!on()) return;
      const p = request.safeParse(raw);
      if (!p.success) return invalidate(raw);
      const { requestId, timestamp, type, request: r } = p.data;
      const url = new URL(r.url);
      if (!/^https?:$/.test(url.protocol)) return;
      const item = {
        start: timestamp,
        mime: "",
        site: url.origin,
        entry: {
          seq: 0,
          method: mask.text(r.method).slice(0, 32),
          url: mask.url(r.url),
          status: 0,
          resourceType: type?.slice(0, 64) ?? "Other",
          durationMs: 0,
          requestHeaders: mask.headers(r.headers, url.origin),
          responseHeaders: {},
        },
      };
      pending.set(requestId, item);
      extra.start(requestId, item, !!p.data.redirectResponse, p.data.redirectHasExtraInfo);
      if (pending.size > 100) pending.delete(pending.keys().next().value as string);
    }),
    ...(["Network.requestWillBeSentExtraInfo", "Network.responseReceivedExtraInfo"] as const).map(
      (method) =>
        cdp.on(method, (raw) => {
          if (!on()) return;
          const p = schema.object({ requestId: schema.string(), headers }).safeParse(raw);
          if (!p.success) return invalidate(raw);
          extra.extra(
            p.data.requestId,
            method === "Network.requestWillBeSentExtraInfo" ? "requestHeaders" : "responseHeaders",
            p.data.headers,
          );
        }),
    ),
    cdp.on("Network.responseReceived", (raw) => {
      if (!on()) return;
      const p = response.safeParse(raw);
      if (!p.success) return invalidate(raw);
      const item = pending.get(p.data.requestId);
      if (!item) return;
      extra.response(p.data.requestId, p.data.hasExtraInfo);
      item.mime = p.data.response.mimeType;
      item.entry.status = Math.trunc(p.data.response.status);
      item.entry.responseHeaders = {
        ...mask.headers(p.data.response.headers, item.site),
        ...item.entry.responseHeaders,
      };
    }),
    cdp.on("Network.loadingFinished", (raw) => {
      if (!on()) return;
      const p = finished.safeParse(raw);
      if (!p.success) return;
      const item = pending.get(p.data.requestId);
      if (!item) return;
      pending.delete(p.data.requestId);
      extra.end(p.data.requestId);
      const epoch = generation;
      const complete = (body?: string) => {
        if (!on() || epoch !== generation) return;
        entries.push(
          BrowserNetworkEntrySchema.parse({
            ...item.entry,
            seq: ++seq,
            durationMs: Math.max(0, (p.data.timestamp - item.start) * 1000),
            body:
              body ??
              `[body omitted; type=${mask.text(item.mime, item.site).slice(0, 128)}; encodedBytes=${p.data.encodedDataLength}]`,
          }),
        );
        if (entries.length > 100) entries.shift();
      };
      // Streaming and large responses are metadata-only. CDP's own buffer is bounded too.
      if (!textMime(item.mime) || p.data.encodedDataLength > 65536 || previews >= 8) {
        complete();
        return;
      }
      previews++;
      void cdp.send("Network.getResponseBody", { requestId: p.data.requestId }).then(
        (raw) => {
          previews--;
          if (!on() || epoch !== generation) return;
          const body = schema
            .object({ body: schema.string().max(65536), base64Encoded: schema.boolean() })
            .safeParse(raw);
          complete(
            body.success && !body.data.base64Encoded
              ? mask.body(body.data.body, item.mime, item.site)?.slice(0, 4096)
              : undefined,
          );
        },
        () => {
          previews--;
          complete();
        },
      ); // Eviction/navigation makes a preview unavailable; metadata remains useful.
    }),
    cdp.on("Network.loadingFailed", (raw) => {
      if (!on()) return;
      const p = schema
        .object({ requestId: schema.string(), timestamp: schema.number() })
        .safeParse(raw);
      if (!p.success) return;
      const item = pending.get(p.data.requestId);
      if (!item) return;
      pending.delete(p.data.requestId);
      extra.end(p.data.requestId);
      entries.push({
        ...item.entry,
        seq: ++seq,
        durationMs: Math.max(0, (p.data.timestamp - item.start) * 1000),
      });
      if (entries.length > 100) entries.shift();
    }),
  ];
  return {
    mask,
    reset,
    read(
      after = 0,
      limit = 20,
    ): Omit<z.infer<typeof BrowserNetworkSchema>, "documentId" | "storage"> {
      on();
      const oldestSeq = entries[0]?.seq ?? seq + 1;
      return {
        entries: entries
          .filter((e) => e.seq > after)
          .slice(0, limit)
          .map((entry) => mask.snapshot(entry)) as Entry[],
        oldestSeq,
        nextSeq: seq,
        dropped: after > 0 && after < oldestSeq - 1,
      };
    },
    dispose() {
      for (const stop of off) stop();
      reset();
    },
  };
}
