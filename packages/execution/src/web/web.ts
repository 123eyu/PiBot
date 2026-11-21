import { createRequire } from "node:module";
import { isIP } from "node:net";
import type { RequestInit, Response } from "undici";
import { withDeadline } from "../core/deadline.ts";
import { ExecError, type PageOptions, type PageResult } from "../core/types.ts";
import { htmlText } from "./html-text.ts";
import {
  isProxyAuthenticationFailure,
  isProxyUnavailable,
  ProxyCredentialsError,
  proxyAgent,
} from "./network-proxy.ts";
import { checkedUrl, checkProxyTarget, publicAddresses, waitForWeb } from "./web-address.ts";
import { webFailure } from "./web-error.ts";

export { type BlockedPageReason, blockedPage } from "./blocked-page.ts";

import { blockedPage } from "./blocked-page.ts";

async function responseBytes(
  response: Response,
  signal: AbortSignal,
  limit: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await waitForWeb(reader.read(), signal);
      if (done) break;
      size += value.length;
      // Count decompressed bytes; Content-Length alone cannot bound compressed responses.
      if (size > limit) throw new ExecError("web_failed", "response_too_large");
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

export async function fetchPage(options: PageOptions): Promise<PageResult> {
  const maxChars = options.maxChars ?? 50_000;
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 1_000_000)
    throw new ExecError("invalid_input");
  const timeout = new AbortController();
  const { Agent, fetch } = createRequire(import.meta.url)("undici") as typeof import("undici");
  const signal = AbortSignal.any([options.signal, timeout.signal]);
  let remaining = 20_000;
  let started = performance.now();
  let timer = setTimeout(() => timeout.abort(), remaining);
  let url = checkedUrl(options.url);
  let stage: NonNullable<ExecError["reason"]> = "dns_failed";
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      signal.throwIfAborted();
      const domain = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      stage = "dns_failed";
      if (options.proxy) await checkProxyTarget(url, signal);
      const addresses = options.proxy ? [] : await publicAddresses(url, signal);
      // Approval has its own bounded lifetime; it must not spend the network budget.
      clearTimeout(timer);
      remaining -= performance.now() - started;
      // Includes bounded policy preparation before the approval's own ten-minute timer starts.
      const approvalSignal = AbortSignal.any([signal, AbortSignal.timeout(720_000)]);
      const allowed = await waitForWeb(
        options.allowDomain(domain, approvalSignal, url.href),
        approvalSignal,
      );
      started = performance.now();
      timer = setTimeout(() => timeout.abort(), Math.max(1, remaining));
      if (!allowed) throw new ExecError("web_blocked", "domain_denied");
      signal.throwIfAborted();
      // Independent dispatcher ignores ambient proxy/auth and pins only the already-checked DNS answers.
      const agent = options.proxy
        ? proxyAgent(options.proxy)
        : new Agent({
            connect: {
              // Keep the original hostname for Host/SNI while only pinning DNS transport addresses.
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
      let response: Response | undefined;
      try {
        const init: RequestInit = {
          signal,
          dispatcher: agent,
          redirect: "manual",
          credentials: "omit",
          headers: {
            "User-Agent": "Pi Bot/0.0.0 (web_fetch)",
            Accept: "text/html,text/plain,application/json,application/xml,application/pdf",
          },
        };
        stage = "connection_failed";
        // Built-in fetch may use Undici 7; our Undici 8 dispatcher needs its matching fetch.
        response = await waitForWeb(fetch(url, init), signal);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          // Maintainers 2026-10-23: follow redirects through the proxy too. Every hop repeats the URL,
          // proxy-target and domain-permission checks at the top of the loop, exactly as for the
          // first request; refusing them broke every DOI link and PubMed lookup for proxy users.
          const location = response.headers.get("location");
          if (!location || redirects === 5) throw new ExecError("web_failed", "redirect_limit");
          url = checkedUrl(new URL(location, url).href);
          continue;
        }
        const mimeType =
          response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
        // Read text within the existing response byte cap; classification uses bounded samples. Other non-2xx
        // responses retain the old error path; no arbitrary error page is exposed to the model.
        if (!response.ok && ![403, 429, 503].includes(response.status))
          throw new ExecError("web_failed", "http_status");
        if (
          !/^text\//.test(mimeType) &&
          mimeType !== "application/pdf" &&
          !/^application\/(?:json|xml|xhtml\+xml|[^;]+\+(?:json|xml))$/.test(mimeType)
        )
          throw new ExecError(
            response.ok ? "web_blocked" : "web_failed",
            response.ok ? "unsupported_content_type" : "http_status",
          );
        stage = "body_failed";
        // PDFs commonly spend most bytes on embedded fonts and object tables rather than text.
        // A 10 MiB cap keeps useful official documents viable; brain still parses only 50 pages
        // in a resource-limited worker. Other responses retain the stricter proxy/direct caps.
        const byteLimit =
          mimeType === "application/pdf"
            ? 10 * 1024 * 1024
            : options.proxy
              ? 1048576
              : 5 * 1024 * 1024;
        const bytes = await responseBytes(response, signal, byteLimit);
        if (mimeType === "application/pdf") {
          if (!response.ok) throw new ExecError("web_failed", "http_status");
          return {
            url: url.href,
            domain,
            title: "",
            text: "",
            truncated: false,
            mimeType,
            bytes,
            length: 0,
          };
        }
        const content = new TextDecoder().decode(bytes);
        stage = "html_failed";
        const extracted = mimeType.includes("html")
          ? await htmlText(content)
          : { title: "", text: content };
        // htmlText loads its parser lazily; a stop or timeout during that load still wins.
        signal.throwIfAborted();
        const text = extracted.text.trim();
        const truncated = text.length > maxChars;
        const responseFacts = { status: response.status, url: url.href };
        const blocked =
          blockedPage(responseFacts, content) ??
          blockedPage(responseFacts, `${extracted.title}\n${text}`);
        if (!response.ok && !blocked) throw new ExecError("web_failed", "http_status");
        return {
          url: url.href,
          domain,
          title: extracted.title,
          text: text.slice(0, maxChars) + (truncated ? "\n[已截断 / Truncated]" : ""),
          truncated,
          mimeType,
          /** Characters of page text before the cut, so a caller can say how much it skipped. */
          length: text.length,
          ...(blocked ? { blocked, status: response.status } : {}),
        };
      } finally {
        // Start both cleanups even if either never settles; no late response may retain sockets.
        await withDeadline(
          Promise.all([
            response?.body && !response.body.locked ? response.body.cancel() : Promise.resolve(),
            agent.destroy(),
          ]),
          1000,
          new ExecError("web_failed", "cleanup_failed"),
        );
      }
    }
    throw new ExecError("web_failed", "redirect_limit");
  } catch (error) {
    if (options.signal.aborted) throw new ExecError("web_failed", "cancelled");
    if (timeout.signal.aborted) throw new ExecError("web_failed", "timeout");
    if (isProxyAuthenticationFailure(error)) throw new ExecError("web_failed", "proxy_auth_failed");
    if (error instanceof ProxyCredentialsError)
      throw new ExecError("web_failed", "proxy_credentials_unavailable");
    if (isProxyUnavailable(error)) throw new ExecError("web_failed", "proxy_unavailable");
    if (error instanceof ExecError) {
      if (error.code === "web_failed" && !error.reason) throw new ExecError("web_failed", stage);
      throw error;
    }
    throw webFailure(error, stage);
  } finally {
    clearTimeout(timer);
  }
}
