import { type BlockedPageReason, blockedPage } from "./blocked-page.ts";
import type { SearchResult } from "./duckduckgo.ts";
import { type KeylessFailure, keylessFailure } from "./keyless-error.ts";
import { isProxyFailure, type NetworkProxy } from "./network-proxy.ts";
import { searchResponse } from "./search-http.ts";

// cn avoids www's regional redirect; never follow even a Bing redirect with a query.
const ENDPOINT = "https://cn.bing.com/search";
export class BingError extends Error {
  constructor(
    readonly reason: "blocked" | KeylessFailure,
    readonly blockedReason?: BlockedPageReason,
  ) {
    super(`bing_${reason}`);
  }
}
function resultUrl(value: string): string | undefined {
  try {
    let url = new URL(value, ENDPOINT);
    const internal = (host: string) => host === "bing.com" || host.endsWith(".bing.com");
    if (internal(url.hostname) && url.pathname === "/ck/a") {
      const encoded = url.searchParams.get("u");
      if (!encoded) return;
      const target = encoded.startsWith("a1")
        ? /^[A-Za-z0-9_-]+={0,2}$/.test(encoded.slice(2))
          ? Buffer.from(encoded.slice(2), "base64url").toString("utf8")
          : ""
        : encoded;
      url = new URL(target);
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      internal(url.hostname)
    )
      return;
    return url.href;
  } catch {
    // Search-page links are untrusted data; an undecodable tracking URL is discarded.
    return;
  }
}
const BING_HOSTS = new Set(["www.bing.com", "cn.bing.com", "bing.com"]);
/** A Bing-to-Bing regional redirect as a /search URL keeping the query; anything else is refused. */
function bingRedirect(location: string | undefined, from: URL): string | undefined {
  if (!location) return;
  try {
    const target = new URL(location, from);
    if (
      target.protocol !== "https:" ||
      !BING_HOSTS.has(target.hostname) ||
      target.host === from.host
    )
      return;
    const next = new URL("/search", target.origin);
    for (const [key, value] of from.searchParams) next.searchParams.set(key, value);
    const market = target.searchParams.get("mkt");
    if (market && /^[a-z]{2}-[A-Z]{2}$/.test(market)) next.searchParams.set("mkt", market);
    return next.href;
  } catch {
    return;
  }
}
export async function parseBing(html: string, count: number): Promise<SearchResult[]> {
  // Loaded on first search, not with the brain.
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(html);
  if (
    document.querySelector('#b_captcha, #captcha, [id*="captcha"], iframe[src*="captcha"]') ||
    (!document.querySelector("#b_results li.b_algo h2 a") &&
      /verify you are human|unusual traffic|solve the challenge|one last step|检测到异常流量|请完成验证|人机验证/i.test(
        document.body?.textContent ?? html,
      ))
  )
    throw new BingError("blocked", "anti_bot_page");
  const container = document.querySelector("#b_results");
  if (!container) throw new BingError("structure");
  const rows = container.querySelectorAll("li.b_algo");
  if (!rows.length) {
    if (
      container.querySelector(".b_no") &&
      /no results|没有找到|未找到|找不到|没有与/i.test(container.textContent ?? "")
    )
      return [];
    throw new BingError("structure");
  }
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  let recognized = false;
  for (const row of rows) {
    if (
      row.matches(".b_ad, .b_adTop, [data-ad]") ||
      row.querySelector(".b_ad, .b_adlabel, .b_adLabel")
    ) {
      recognized = true;
      continue;
    }
    const link = row.querySelector("h2 a");
    recognized ||= !!link;
    const title = link?.textContent?.replace(/\s+/g, " ").trim().slice(0, 500);
    const url = resultUrl(link?.getAttribute("href") ?? "");
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title,
      url,
      snippet: (row.querySelector(".b_caption p, .b_snippet, p")?.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 2000),
    });
    if (results.length >= Math.max(1, Math.min(10, count))) break;
  }
  if (!recognized) throw new BingError("structure");
  return results;
}
export async function bingSearch(
  query: string,
  count: number,
  parent: AbortSignal,
  http: typeof searchResponse = searchResponse,
  proxy?: NetworkProxy,
): Promise<SearchResult[]> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(20_000)]);
  const url = new URL(ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.max(1, Math.min(10, count))));
  const headers = {
    accept: "text/html",
    "accept-encoding": "identity",
    "user-agent": "PiBot/1.0 (HTML search)",
  };
  try {
    signal.throwIfAborted();
    let response = await http({ url: url.href, proxy, signal, headers });
    signal.throwIfAborted();
    // Bing sends visitors between cn.bing.com and www.bing.com by region (to the home page, not
    // /search). Follow that one hop inside Bing only, back onto /search with the same query.
    const regional =
      response.status >= 300 && response.status < 400 && bingRedirect(response.location, url);
    if (regional) {
      response = await http({ url: regional, proxy, signal, headers });
      signal.throwIfAborted();
    }
    if (response.status !== 200)
      throw new BingError("blocked", blockedPage({ status: response.status }, response.text));
    const blocked = blockedPage({ status: response.status }, response.text);
    if (blocked) throw new BingError("blocked", blocked);
    // The parser loads lazily (startup cost); a stop during that load must not return results.
    const results = await parseBing(response.text, count);
    signal.throwIfAborted();
    return results;
  } catch (error) {
    if (parent.aborted) throw parent.reason;
    if (isProxyFailure(error)) throw error;
    if (error instanceof BingError) throw error;
    throw new BingError(signal.aborted ? "unavailable" : keylessFailure(error));
  }
}
