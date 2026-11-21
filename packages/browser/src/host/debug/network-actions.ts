import {
  type BrowserRequestSchema,
  type BrowserSecretSchema,
  RpcError,
  RpcErrorCodes,
} from "@pibot/browser-contract/full";
import { z } from "zod";
import type { BotTab } from "../tab.ts";

const fail = () => new RpcError(RpcErrorCodes.invalidParams, "browser_network_refused");
function originOf(tab: BotTab, expected?: string) {
  const url = new URL(tab.url);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    (expected !== undefined && url.origin !== expected)
  )
    throw fail();
  return url.origin;
}
const pairs = z.object({ entries: z.array(z.tuple([z.string(), z.string()])).max(10000) });
async function storage(tab: BotTab, kind: "localStorage" | "sessionStorage", origin: string) {
  const raw = await tab.control.send("DOMStorage.getDOMStorageItems", {
    storageId: { securityOrigin: origin, isLocalStorage: kind === "localStorage" },
  });
  return pairs.parse(raw).entries;
}
const cookiesSchema = z.object({
  cookies: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        secure: z.boolean(),
        httpOnly: z.boolean(),
        sameSite: z.string().optional(),
      }),
    )
    .max(10000),
});
async function cookies(tab: BotTab) {
  return cookiesSchema.parse(await tab.control.send("Network.getCookies", { urls: [tab.url] }))
    .cookies;
}
export async function networkMetadata(tab: BotTab, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!/^https?:$/.test(new URL(tab.url).protocol)) return [];
  const origin = originOf(tab);
  const document = tab.documentId;
  const result: {
    kind: "localStorage" | "sessionStorage" | "cookie";
    name: string;
    length: number;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: string;
  }[] = [];
  for (const kind of ["localStorage", "sessionStorage"] as const) {
    for (const [name, value] of (await storage(tab, kind, origin)).slice(0, 50))
      result.push({
        kind,
        name: tab.networkMask()?.text(name).slice(0, 256) ?? "[masked]",
        length: value.length,
      });
  }
  for (const { name, value, ...flags } of (await cookies(tab)).slice(0, 50))
    result.push({
      kind: "cookie",
      name: tab.networkMask()?.text(name).slice(0, 256) ?? "[masked]",
      length: value.length,
      ...flags,
    });
  signal?.throwIfAborted();
  if (tab.documentId !== document) throw fail();
  return result;
}

// Host-authored function in an isolated world: page scripts cannot replace fetch/JSON/Headers.
// The function itself verifies the origin again, closing the navigation-between-awaits race.
const fetchFunction = `async function(input) {
  if (location.origin !== input.origin) throw new Error('origin');
  const url = new URL(input.url, input.origin);
  if (url.origin !== input.origin || url.username || url.password) throw new Error('origin');
  globalThis.pibotNetworkAbort = new AbortController();
  const response = await fetch(url.href, { method: input.method, headers: input.headers, body: input.body, credentials: 'include', redirect: 'error', mode: 'same-origin', signal: AbortSignal.any([AbortSignal.timeout(8000), globalThis.pibotNetworkAbort.signal]) });
  const headers = Object.fromEntries(response.headers);
  let body = ''; let complete = false;
  const mime = response.headers.get('content-type') || '';
  if (/^(text\\/|application\\/(json|[^;]+\\+json|xml|javascript|x-www-form-urlencoded))/i.test(mime) && response.body) {
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let size = 0;
    try { while (size < 16384) { const item = await reader.read(); if (item.done) { complete = true; break; } size += item.value.byteLength; if (size > 16384) break; body += decoder.decode(item.value, {stream:true}); } } finally { await reader.cancel(); }
  }
  return {status: response.status, headers, body: complete ? body : '', mime};
}`;
export async function pageRequest(
  tab: BotTab,
  input: z.infer<typeof BrowserRequestSchema>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  originOf(tab, input.origin);
  const url = new URL(input.url, input.origin);
  if (
    url.origin !== input.origin ||
    url.username ||
    url.password ||
    Buffer.byteLength(input.body ?? "") > 16384
  )
    throw fail();
  if (["GET", "HEAD"].includes(input.method) && input.body !== undefined) throw fail();
  const mask = tab.networkMask();
  if (!mask) throw fail();
  const generation = mask.generation;
  if (input.url.includes("«secret:")) throw fail();
  const resolve = (value: string) => {
    const resolved = value.replace(/«secret:h[a-f0-9]{32}»/g, (handle: string) => {
      const entry = mask.get(handle, input.origin);
      if (!entry) throw fail();
      tab.registerSecret(entry.value, handle);
      return entry.value;
    });
    if (value.replace(/«secret:h[a-f0-9]{32}»/g, "").includes("«secret:")) throw fail();
    return resolved;
  };
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (/^(cookie|host|origin|referer|connection|content-length|proxy-|sec-)/i.test(name))
      throw fail();
    if (
      !/^(accept|content-type|accept-language)$/i.test(name) &&
      !/«secret:h[a-f0-9]{32}»/.test(value)
    )
      throw fail();
  }
  const resolvedHeaders = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([name, value]) => [name, resolve(value)]),
  );
  const resolvedBody = input.body === undefined ? undefined : resolve(input.body);
  if (Buffer.byteLength(resolvedBody ?? "") > 16384) throw fail();
  if (
    Object.values(resolvedHeaders).reduce((size, value) => size + Buffer.byteLength(value), 0) >
    65536
  )
    throw fail();
  if (Object.values(resolvedHeaders).some((value) => /[\r\n\0]/.test(value))) throw fail();
  const executionInput = { ...input, headers: resolvedHeaders, body: resolvedBody };
  const document = tab.documentId;
  const tree = z
    .object({ frameTree: z.object({ frame: z.object({ id: z.string() }) }) })
    .parse(await tab.control.send("Page.getFrameTree"));
  const world = z.object({ executionContextId: z.number() }).parse(
    await tab.control.send("Page.createIsolatedWorld", {
      frameId: tree.frameTree.frame.id,
      worldName: "pibot-network",
    }),
  );
  if (document !== tab.documentId) throw fail();
  const start = Date.now();
  signal?.throwIfAborted();
  const abort = () => {
    void tab.control
      .send("Runtime.evaluate", {
        contextId: world.executionContextId,
        expression: "globalThis.pibotNetworkAbort?.abort()",
      })
      .catch(() => {
        /* Navigation destroys the isolated world and its request. */
      });
  };
  signal?.addEventListener("abort", abort, { once: true });
  let raw: unknown;
  try {
    if (document !== tab.documentId || mask !== tab.networkMask() || generation !== mask.generation)
      throw fail();
    raw = await tab.control.send(
      "Runtime.callFunctionOn",
      {
        executionContextId: world.executionContextId,
        functionDeclaration: fetchFunction,
        arguments: [{ value: executionInput }],
        awaitPromise: true,
        returnByValue: true,
      },
      10000,
    );
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  signal?.throwIfAborted();
  const parsed = z
    .object({
      result: z.object({
        value: z.object({
          status: z.number().int(),
          headers: z.record(z.string(), z.string()),
          body: z.string().max(16384),
          mime: z.string(),
        }),
      }),
    })
    .safeParse(raw);
  if (!parsed.success || document !== tab.documentId || generation !== mask.generation)
    throw fail();
  const value = parsed.data.result.value;
  return mask.snapshot({
    seq: 0,
    method: input.method,
    url: mask.url(url.href),
    status: value.status,
    resourceType: "Fetch",
    durationMs: Date.now() - start,
    requestHeaders: mask.headers(resolvedHeaders, input.origin),
    responseHeaders: mask.headers(value.headers, input.origin),
    body:
      mask.body(value.body, value.mime, input.origin)?.slice(0, 4096) ??
      `[body omitted; type=${mask.text(value.mime, input.origin).slice(0, 128)}; capturedBytes=${Buffer.byteLength(value.body)}]`,
  });
}
export async function captureSecret(
  tab: BotTab,
  input: z.infer<typeof BrowserSecretSchema>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  originOf(tab, input.origin);
  const document = input.documentId;
  if (tab.documentId !== document) throw fail();
  const mask = tab.networkMask();
  if (!mask) throw fail();
  const generation = mask.generation;
  let value: string | undefined;
  let handle: string | undefined;
  if (input.kind === "handle") {
    const entry = input.handle ? mask.get(input.handle, input.origin) : undefined;
    if (!entry || entry.name !== input.name) throw fail();
    value = entry.value;
    handle = input.handle;
  } else if (input.kind === "cookie") {
    const matches = (await cookies(tab)).filter((c) => c.name === input.name);
    if (matches.length === 1) value = matches[0]?.value;
  } else {
    value = (await storage(tab, input.kind, input.origin)).find(
      ([name]) => name === input.name,
    )?.[1];
  }
  signal?.throwIfAborted();
  if (
    value === undefined ||
    value.length > 65536 ||
    value.includes("\0") ||
    document !== tab.documentId ||
    mask !== tab.networkMask() ||
    generation !== mask.generation
  )
    throw fail();
  if (!handle)
    handle = mask.capture(
      value,
      input.name,
      input.origin,
      input.kind === "handle" ? "network" : input.kind,
    )?.handle;
  if (!handle) throw fail();
  tab.registerSecret(value, handle);
  const entry = mask.get(handle, input.origin);
  if (!entry) throw fail();
  return {
    handle,
    kind: entry.kind,
    site: mask.known(entry.site),
    name: mask.known(entry.name),
    length: value.length,
  };
}
