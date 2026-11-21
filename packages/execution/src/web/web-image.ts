import { createRequire } from "node:module";
import { isIP } from "node:net";
import type { Dispatcher, Response } from "undici";
import { withDeadline } from "../core/deadline.ts";
import { ExecError, type PageOptions } from "../core/types.ts";
import { isProxyAuthenticationFailure, proxyAgent } from "./network-proxy.ts";
import { checkedUrl, checkProxyTarget, publicAddresses, waitForWeb } from "./web-address.ts";
import { webFailure } from "./web-error.ts";

const imageLimit = 10 * 1024 * 1024;

async function imageBytes(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new ExecError("web_failed", "body_failed");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await waitForWeb(reader.read(), signal);
      if (done) break;
      size += value.length;
      // Bound decompressed bytes, including chunked responses with no Content-Length.
      if (size > imageLimit) throw new ExecError("web_failed", "response_too_large");
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    try {
      await withDeadline(reader.cancel(), 1000, new ExecError("web_failed", "cleanup_failed"));
    } finally {
      reader.releaseLock();
    }
  }
}

/** Explicit image requests share web_fetch's address rules; redirects never create a second request. */
export async function fetchImage(options: Omit<PageOptions, "maxChars">) {
  const timeout = AbortSignal.timeout(20_000);
  const { Agent, fetch } = createRequire(import.meta.url)("undici") as typeof import("undici");
  const signal = AbortSignal.any([options.signal, timeout]);
  let agent: Dispatcher | undefined;
  let response: Response | undefined;
  let stage: NonNullable<ExecError["reason"]> = "dns_failed";
  try {
    const url = checkedUrl(options.url);
    const domain = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (options.proxy) await checkProxyTarget(url, signal);
    const addresses = options.proxy ? [] : await publicAddresses(url, signal);
    if (!(await waitForWeb(options.allowDomain(domain, signal, url.href), signal)))
      throw new ExecError("web_blocked", "domain_denied");
    signal.throwIfAborted();
    // Proxy selection is frozen for this request; never fall back to a direct connection.
    agent = options.proxy
      ? proxyAgent(options.proxy)
      : new Agent({
          connect: {
            ...(url.protocol === "https:" && !isIP(domain) ? { servername: domain } : {}),
            lookup: (_host, lookupOptions, callback) => {
              if (lookupOptions.all) callback(null, addresses);
              else {
                const address = addresses[0];
                if (!address) callback(new Error("No address"), "", 4);
                else callback(null, address.address, address.family);
              }
            },
          },
        });
    stage = "connection_failed";
    response = await waitForWeb(
      fetch(url, {
        signal,
        dispatcher: agent,
        redirect: "manual",
        credentials: "omit",
        headers: { "User-Agent": "Pi Bot/0.0.0 (image_load)", Accept: "image/*" },
      }),
      signal,
    );
    if (response.status >= 300 && response.status < 400)
      throw new ExecError("web_failed", "redirect_limit");
    if (!response.ok) throw new ExecError("web_failed", "http_status");
    const mimeType =
      response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!mimeType.startsWith("image/"))
      throw new ExecError("web_blocked", "unsupported_content_type");
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > imageLimit)
      throw new ExecError("web_failed", "response_too_large");
    stage = "body_failed";
    return { data: await imageBytes(response, signal), mimeType };
  } catch (error) {
    if (options.signal.aborted) throw new ExecError("web_failed", "cancelled");
    if (timeout.aborted) throw new ExecError("web_failed", "timeout");
    if (isProxyAuthenticationFailure(error)) throw new ExecError("web_failed", "proxy_auth_failed");
    throw webFailure(error, stage);
  } finally {
    await withDeadline(
      Promise.all([
        response?.body && !response.body.locked ? response.body.cancel() : Promise.resolve(),
        agent?.destroy() ?? Promise.resolve(),
      ]),
      1000,
      new ExecError("web_failed", "cleanup_failed"),
    );
  }
}
