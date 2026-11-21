import { z } from "zod";
import type { Cdp } from "../cdp.ts";
import type { Session } from "../platform.ts";

/**
 * Google compatibility mode. Google's sign-in refuses the Electron engine whatever Chromium
 * identity it shows (measured in Google sign-in tests); a Firefox identity is accepted.
 * Only when the user turned the switch on for this Bot, and only on these hosts, does its browser
 * present itself as Firefox; every other site keeps the ordinary Chromium identity.
 */
const EXACT = new Set(["google.com", "accounts.youtube.com"]);

export function isGoogleCompatHost(url: string) {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  return EXACT.has(host) || host.endsWith(".google.com");
}

// The version the sign-in was measured with (2026-10, Firefox 143). A Firefox UA with the real
// platform: navigator.platform already matches Firefox's value on all three systems.
const FIREFOX = "Gecko/20100101 Firefox/143.0";
export function firefoxUserAgent(platform: NodeJS.Platform) {
  const system =
    platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10.15"
      : platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${system}; rv:143.0) ${FIREFOX}`;
}

/**
 * Header side of the identity: a main-frame request goes out with the identity of the address
 * it loads (the first request after leaving Google would otherwise still say Firefox), every
 * other request with its tab's current one (`ofContents`; a popup's is not its webContents'
 * user agent, see BotTab.adopt). Firefox sends no `sec-ch-ua*` client hints, so they are dropped
 * whenever the identity is Firefox. The session has no other onBeforeSendHeaders.
 */
export function installGoogleCompatHeaders(
  session: Session,
  identity: { forUrl(url: string): string; ofContents(id: number): string | undefined },
  firefox: string,
) {
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const current =
      details.webContentsId === undefined ? undefined : identity.ofContents(details.webContentsId);
    const userAgent =
      details.resourceType === "mainFrame"
        ? identity.forUrl(details.url)
        : (current ?? identity.forUrl(details.url));
    const headers = { ...details.requestHeaders };
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase();
      if (lower === "user-agent") delete headers[name];
      else if (userAgent === firefox && lower.startsWith("sec-ch-ua")) delete headers[name];
    }
    headers["User-Agent"] = userAgent;
    callback({ requestHeaders: headers });
  });
  return () => session.webRequest.onBeforeSendHeaders(null);
}

/**
 * The engine's own client hints (`navigator.userAgentData` with the high-entropy values), which
 * Electron keeps under the Firefox user agent of an ordinary tab. A popup's identity goes through
 * CDP (BotTab.adopt), which clears them unless given; passing these keeps the popup's Google page
 * the same as an ordinary tab's, the combination Google accepted in sign-in tests.
 */
const Brand = z.object({ brand: z.string().max(100), version: z.string().max(50) });
const UserAgentMetadataSchema = z.object({
  // Never empty in the engine's own values; empty ones come from an override.
  brands: z.array(Brand).min(1).max(10),
  fullVersionList: z.array(Brand).max(10),
  platform: z.string().max(50),
  platformVersion: z.string().max(50),
  architecture: z.string().max(50),
  model: z.string().max(100),
  mobile: z.boolean(),
  bitness: z.string().max(10),
  wow64: z.boolean(),
  formFactors: z.array(z.string().max(30)).max(10).optional(),
});
export type UserAgentMetadata = z.infer<typeof UserAgentMetadataSchema>;
const HIGH_ENTROPY = [
  "architecture",
  "bitness",
  "fullVersionList",
  "model",
  "platformVersion",
  "wow64",
  "formFactors",
];
const IDENTITY_WORLD = "pibot-identity";

/**
 * Reads the values in an isolated world of the tab's current page (the page cannot see or alter
 * it). undefined where the page has none: userAgentData exists only in secure contexts.
 */
export async function readUserAgentMetadata(cdp: Cdp) {
  const { frameTree } = await cdp.send<{ frameTree: { frame: { id: string } } }>(
    "Page.getFrameTree",
  );
  const { executionContextId } = await cdp.send<{ executionContextId: number }>(
    "Page.createIsolatedWorld",
    { frameId: frameTree.frame.id, worldName: IDENTITY_WORLD },
  );
  const { result } = await cdp.send<{ result: { value?: unknown } }>(
    "Runtime.evaluate",
    {
      contextId: executionContextId,
      expression: `navigator.userAgentData ? navigator.userAgentData.getHighEntropyValues(${JSON.stringify(HIGH_ENTROPY)}) : null`,
      awaitPromise: true,
      returnByValue: true,
    },
    3000,
  );
  const parsed = UserAgentMetadataSchema.safeParse(result.value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * `Emulation.setUserAgentOverride` for a popup's next document: the tab's own identity clears the
 * override (the page then shows the ordinary Chromium identity, client hints included); another one
 * is set with the engine's client hints when known.
 */
export function userAgentOverride(
  userAgent: string,
  base: string,
  metadata: UserAgentMetadata | undefined,
) {
  if (userAgent === base) return { userAgent: "" };
  return metadata ? { userAgent, userAgentMetadata: metadata } : { userAgent };
}

/**
 * Where to go when the switch turns on while a tab shows Google's refusal: back into the sign-in
 * it came from (`continue=`, only a Google address), or the account page.
 */
export function googleRetryUrl(url: string) {
  try {
    const next = new URL(url).searchParams.get("continue");
    if (next && isGoogleCompatHost(next)) return next;
  } catch {
    // Not a URL; fall through.
  }
  return "https://accounts.google.com/";
}
