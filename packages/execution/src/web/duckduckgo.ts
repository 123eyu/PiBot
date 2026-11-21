import { type BlockedPageReason, blockedPage } from "./blocked-page.ts";
import { type KeylessFailure, keylessFailure } from "./keyless-error.ts";
import { isProxyFailure, type NetworkProxy } from "./network-proxy.ts";
import { SearchHttpError, searchResponse } from "./search-http.ts";

const ENDPOINT = "https://html.duckduckgo.com/html/";
export class DuckDuckGoError extends Error {
  constructor(
    readonly reason: "blocked" | KeylessFailure,
    readonly blockedReason?: BlockedPageReason,
  ) {
    super(`duckduckgo_${reason}`);
  }
}
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}
function resultUrl(value: string): string | undefined {
  try {
    let url = new URL(value, ENDPOINT);
    const duck = (host: string) => host === "duckduckgo.com" || host.endsWith(".duckduckgo.com");
    if (duck(url.hostname) && url.pathname === "/l/") {
      const target = url.searchParams.get("uddg");
      if (!target) return;
      url = new URL(target);
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      duck(url.hostname)
    )
      return;
    return url.href;
  } catch {
    // Malformed or non-web links are untrusted search data, not instructions to navigate.
    return;
  }
}
export async function parseDuckDuckGo(html: string, count: number): Promise<SearchResult[]> {
  // Loaded on first search, not with the brain.
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(html);
  if (
    document.querySelector(
      '#challenge-form, #anomaly-form, .anomaly-modal, [id*="captcha"], form[action*="anomaly.js"]',
    ) ||
    /unfortunately, bots use duckduckgo too|please complete the following challenge|unusual traffic from your computer network/i.test(
      document.body?.textContent ?? html,
    )
  )
    throw new DuckDuckGoError("blocked", "anti_bot_page");
  const container = document.querySelector(".results, #links");
  if (!container) throw new DuckDuckGoError("structure");
  if (
    !container.querySelector("a.result__a") &&
    (container.querySelector(".no-results, .result--no-result") ||
      /no results found for|no more results/i.test(container.textContent ?? ""))
  )
    return [];
  const rows = container.querySelectorAll(".result");
  if (!rows.length) throw new DuckDuckGoError("structure");
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  let recognized = false;
  for (const row of rows) {
    if (
      row.matches('.result--ad, .result--ads, [data-layout="ad"]') ||
      row.querySelector('.result__badge, a[href*="/y.js"]')
    ) {
      recognized = true;
      continue;
    }
    const link = row.querySelector("a.result__a");
    recognized ||= !!link;
    const title = link?.textContent?.replace(/\s+/g, " ").trim().slice(0, 500);
    const url = resultUrl(link?.getAttribute("href") ?? "");
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title,
      url,
      snippet: (row.querySelector(".result__snippet")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 2000),
    });
    if (results.length >= count) break;
  }
  if (!recognized) throw new DuckDuckGoError("structure");
  return results;
}
export async function duckduckgoSearch(
  query: string,
  count: number,
  parent: AbortSignal,
  http: typeof searchResponse = searchResponse,
  proxy?: NetworkProxy,
): Promise<SearchResult[]> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(20_000)]);
  const body = new URLSearchParams({ q: query }).toString();
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      // POST keeps the query out of the URL. A constant UA exposes no host/platform identity.
      const response = await http({
        url: ENDPOINT,
        proxy,
        method: "POST",
        body,
        signal,
        headers: {
          accept: "text/html",
          "accept-encoding": "identity",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "PiBot/1.0 (HTML search)",
        },
      });
      signal.throwIfAborted();
      if (response.status !== 200)
        throw new DuckDuckGoError(
          "blocked",
          blockedPage({ status: response.status }, response.text),
        );
      const blocked = blockedPage({ status: response.status }, response.text);
      if (blocked) throw new DuckDuckGoError("blocked", blocked);
      // The parser loads lazily (startup cost); a stop during that load must not return results.
      const results = await parseDuckDuckGo(response.text, Math.max(1, Math.min(10, count)));
      signal.throwIfAborted();
      return results;
    } catch (error) {
      if (parent.aborted) throw parent.reason;
      if (isProxyFailure(error)) throw error;
      if (signal.aborted) throw new DuckDuckGoError("unavailable");
      if (attempt === 0 && error instanceof SearchHttpError && error.reason === "network") continue;
      if (error instanceof DuckDuckGoError) throw error;
      throw new DuckDuckGoError(keylessFailure(error));
    }
  }
}
