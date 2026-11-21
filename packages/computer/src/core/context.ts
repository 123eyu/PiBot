import { createHash } from "node:crypto";
import type { HostComputerApp } from "@pibot/protocol-base";
import type { createFrameRegistry } from "../actions/frames.ts";
import type { ImageCodec, RawImage } from "../actions/image.ts";
import type { ElementFacts } from "../actions/tree.ts";
import type { createActivityTracker } from "../guard/activity.ts";
import { isAlwaysBlocked, isBlockedWindow } from "../guard/blocklist.ts";
import { type GrantRegistry, type GrantScope, grantCovers } from "../guard/grants.ts";
import { resolveAppName } from "./app-names.ts";
import { ComputerError } from "./errors.ts";
import type { AppInfo, ComputerDriver, Rect, WindowInfo } from "./types.ts";

/** A text input a complete password-field scan covered, by identity and place. */
export interface CertifiedInput {
  key: string;
  frame: Rect;
}

/** Whole-display capture from the host (Electron desktopCapturer + screen). */
export interface DisplayCapture {
  /** `index` follows the host's display order, 0 = main display. */
  capture(index: number, signal?: AbortSignal): Promise<{ image: RawImage; bounds: Rect }>;
  /** Index of the display showing most of `rect` (global points), if any. */
  displayFor?(rect: Rect): number | undefined;
}

/** The OS's own answer to "may this process record the screen" (macOS TCC preflight). */
export type ScreenAccess = "granted" | "denied" | "unknown";

export interface ServiceContext {
  driver: ComputerDriver;
  grants: GrantRegistry;
  codec: ImageCodec;
  displays?: DisplayCapture;
  /** Screen Recording as the host sees it; absent where no such permission exists. */
  screenAccess?(): ScreenAccess;
  /** User-editable blocklist (chat apps, mail); the never-list is built in. */
  blocked(app: { id: string; name: string }): boolean;
  frames: ReturnType<typeof createFrameRegistry>;
  activity: ReturnType<typeof createActivityTracker>;
  /** Element facts per window from the last tree read; Cua tokens die with the next read. */
  elements: Map<string, WindowFacts>;
  /** Short-lived app list: one tool call resolves its app more than once (382 ms on Windows). */
  apps?: { at: number; list: Promise<AppInfo[]> };
  /** Short-lived window list per app pid, for the same reason (574 ms on Windows). */
  windows?: Map<number, { at: number; list: Promise<WindowInfo[]> }>;
  /** OS aliases only, never grants or cached running processes. */
  appNames?: Map<string, string>;
  now?: () => number;
  secureScans?: Map<
    string,
    {
      at: number;
      grantKey: string;
      frames: Rect[];
      complete: boolean;
      /** The text inputs this scan covered, by identity and place (see `CertifiedInput`). */
      certified?: CertifiedInput[];
    }
  >;
  /**
   * The newest complete password-field scan per window, kept past the cache's TTL: a window's
   * password fields do not disappear on a timer, and losing the geometry would both unmark them
   * in the tree and refuse every input to a plain text field next to them.
   */
  secureKnown?: Map<
    string,
    { grantKey: string; frames: Rect[]; at: number; certified: CertifiedInput[] }
  >;
}

export interface WindowFacts {
  facts: Map<string, ElementFacts>;
  /**
   * The tokens handed to the model by `ui_tree`, newest last, with the identity fields
   * (`chain`, `ordinal`, `siblings`) filled in so they stand on their own. Element actions read
   * the tree before acting, so a token has to stay usable across an unbounded number of
   * those reads; keeping a ledger of what was issued beats keeping the last N snapshots, whose
   * window the model's own read fell out of after nine actions.
   */
  issued?: Map<string, ElementFacts>;
  /** The limits of that read, so the pre-action verification reads as much of the tree again. */
  limits?: { maxNodes: number; maxDepth: number };
  /** Recovery hints must come from a read under the same grant. */
  grantKey?: string;
  /**
   * At least one text element of that read could not be certified as "not a password field"
   *Input into it needs a fresh OS focus confirmation. Element-targeted input checks
   * the element's own `secureUnverified` instead(its identity survives re-reads, the window-wide
   * flag does not) — see `confirmUnscannedInput`.
   */
  secureScanIncomplete: boolean;
}

/**
 * A running app list only changes when an app starts or quits, and reading it costs 382 ms on
 * Windows. A cached list that misses the app the model means is
 * not a wrong answer: `resolveApp` asks again without the cache when nothing matched.
 */
const APPS_TTL_MS = 30_000;
const OPEN_POLL_MS = 200;
/**
 * Window lists are reused only for a moment: Cua enumerates an app's windows per call (574 ms on
 * Windows) and one tool call resolves the target window several times. Everything that can
 * change the window set or its geometry forgets the entry (open, pointer, window shortcuts,
 * menus), and a list that no longer names the window is read again (resolveWindow), so this
 * expiry is a backstop rather than the mechanism.
 */
const WINDOWS_TTL_MS = 5000;

/** `fresh`: skip the cache (an app the cached list does not have may have just started). */
export function runningApps(
  ctx: ServiceContext,
  signal: AbortSignal,
  fresh = false,
): Promise<AppInfo[]> {
  const t = Date.now();
  if (fresh || !ctx.apps || t - ctx.apps.at > APPS_TTL_MS) {
    const list = ctx.driver.listApps(signal);
    ctx.apps = { at: t, list };
    // A failed read must not be served from the cache to the next caller.
    list.catch(() => {
      if (ctx.apps?.list === list) ctx.apps = undefined;
    });
  }
  return ctx.apps.list;
}

/** An app list read before `open` cannot show the app it started. */
export function forgetRunningApps(ctx: ServiceContext) {
  ctx.apps = undefined;
}

/** Drops the cached window list of one app, or of every app when no pid is given. */
export function forgetWindows(ctx: ServiceContext, pid?: number) {
  if (pid === undefined) ctx.windows?.clear();
  else ctx.windows?.delete(pid);
}

/**
 * An app's windows, from a list read moments ago when there is one. The same call resolves the
 * same window more than once (app check, window, batch pin), and on Windows every enumeration of
 * Cua's window list costs 574 ms of a call whose action takes 11 ms.
 */
export function windowsOf(
  ctx: ServiceContext,
  signal: AbortSignal,
  pid: number,
  fresh = false,
): Promise<WindowInfo[]> {
  ctx.windows ??= new Map();
  const now = (ctx.now ?? Date.now)();
  const cached = ctx.windows.get(pid);
  if (!fresh && cached && now - cached.at >= 0 && now - cached.at < WINDOWS_TTL_MS) {
    // The read ran under another call's signal; this caller's cancellation must still win.
    return cached.list.then((list) => {
      if (signal.aborted) throw new ComputerError("cancelled", "resolve_window");
      return list;
    });
  }
  const list = ctx.driver.windows(pid, signal);
  ctx.windows.set(pid, { at: now, list });
  // A failed read must not be served from the cache to the next caller.
  list.catch(() => {
    if (ctx.windows?.get(pid)?.list === list) ctx.windows.delete(pid);
  });
  while (ctx.windows.size > 16) ctx.windows.delete(ctx.windows.keys().next().value as number);
  return list;
}

export interface Call {
  displayRead?: import("./types.ts").DisplayReadDiagnostic;
  scope: GrantScope;
  /** Stable per grant without keeping the token. */
  grantKey: string;
  signal: AbortSignal;
  treeTiming?: Partial<
    Record<
      | "readMs"
      | "secureMs"
      | "mapMs"
      | "serializeMs"
      | "secureWindowMs"
      | "secureAttributesMs"
      | "secureQueueMs",
      number
    >
  >;
}

export const grantKeyOf = (token: string) =>
  createHash("sha256").update(token).digest("base64url").slice(0, 22);

export function isBlocked(ctx: ServiceContext, app: { id: string; name: string }) {
  return isAlwaysBlocked(app) || ctx.blocked(app);
}

export function describeApp(ctx: ServiceContext, app: AppInfo): HostComputerApp {
  return {
    id: app.id.slice(0, 512),
    name: (app.name || app.id).slice(0, 200),
    pid: app.pid,
    active: app.active,
    blocked: isBlocked(ctx, app),
  };
}

const same = (a: string, b: string) =>
  a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;

function assertAppActive(signal: AbortSignal) {
  if (signal.aborted) throw new ComputerError("cancelled", "app_resolution");
}

/** The running app with this ID, else by name (preferring the granted one among same-named). */
async function findApp(
  ctx: ServiceContext,
  apps: AppInfo[],
  call: Call,
  app: string,
): Promise<AppInfo | undefined> {
  // A name may be shared (on purpose, by a lookalike); among same-named apps prefer the granted one,
  // and the grant check in resolveApp still decides by ID.
  const named = apps.filter((a) => same(a.name, app));
  const direct =
    apps.find((a) => same(a.id, app)) ?? named.find((a) => grantCovers(call.scope, a)) ?? named[0];
  if (direct || !ctx.driver.resolveAppName) return direct;
  const cached = ctx.appNames?.has(app.toLowerCase());
  const id = await resolveAppName(ctx, app, call.signal);
  const found = id ? apps.find((a) => same(a.id, id)) : undefined;
  // An installed replacement may have a new bundle ID; an alias never substitutes for a grant.
  if (!found && cached) {
    const currentId = await resolveAppName(ctx, app, call.signal, true);
    return currentId ? apps.find((a) => same(a.id, currentId)) : undefined;
  }
  return found;
}

const usable = (w: WindowInfo) => w.layer === 0 && w.bounds.width > 1 && w.bounds.height > 1;

// A window that exists for the window server but not yet for Accessibility (just created), or
// an app still launching: both settle within a second or two.
const SETTLING = /ax_window_unresolved|app_launching/;

/**
 * After `open`: waits (bounded) until the app is in the running list with a usable window whose
 * accessibility tree answers (`readable`, a one-element read), so an immediate ui_tree /
 * screenshot finds it. Never fails the open: a slow or windowless app, a window on another
 * Space, or a localized name we cannot match just ends the wait. Returns whether it got there.
 */
export async function waitUntilVisible(
  ctx: ServiceContext,
  call: Call,
  app: string,
  budgetMs: number,
  readable: (app: AppInfo, window: WindowInfo, signal: AbortSignal) => Promise<unknown>,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const left = deadline - Date.now();
    const signal = AbortSignal.any([call.signal, AbortSignal.timeout(Math.max(1, left))]);
    try {
      const found = await findApp(
        ctx,
        await runningApps(ctx, signal, true),
        { ...call, signal },
        app,
      );
      if (found && isBlocked(ctx, found)) return false;
      if (found && !grantCovers(call.scope, found)) return false;
      const windows = found ? (await ctx.driver.windows(found.pid, signal)).filter(usable) : [];
      if (found && windows.length) {
        await readable(found, await resolveWindow(ctx, call, found, undefined), signal);
        return true;
      }
    } catch (error) {
      if (call.signal.aborted) throw new ComputerError("cancelled", "open_wait");
      if (!(error instanceof ComputerError)) throw error;
      // Only a window that is still being set up is worth waiting for.
      if (error.code === "needs_foreground" && !SETTLING.test(error.detail ?? "")) return false;
      if (error.code === "app_blocked" || error.code === "permission_missing") return false;
    }
    if (deadline - Date.now() < OPEN_POLL_MS) return false;
    await new Promise((resolve) => setTimeout(resolve, OPEN_POLL_MS));
    if (call.signal.aborted) throw new ComputerError("cancelled", "open_wait");
  }
}

/** Running app named by the model, checked against the blocklist and the grant. */
export async function resolveApp(ctx: ServiceContext, call: Call, app: string): Promise<AppInfo> {
  const cached = ctx.apps !== undefined;
  // An app opened a moment ago may be missing from a list cached just before; ask once more.
  let apps = await runningApps(ctx, call.signal);
  let found = await findApp(ctx, apps, call, app);
  if (!found && cached) {
    apps = await runningApps(ctx, call.signal, true);
    found = await findApp(ctx, apps, call, app);
  }
  assertAppActive(call.signal);
  // Classic UWP apps (Calculator, Settings) draw in windows owned by ApplicationFrameHost.exe.
  // win-frame-hosts normally pairs each frame with the process inside it, so this fires
  // only when that pairing failed: no child window, an unreadable image path, or an ambiguous
  // AUMID. Say so instead of "not running", which sends the model back to open_app.
  if (!found && app.includes("!") && apps.some((a) => same(a.id, "applicationframehost.exe")))
    throw new ComputerError("app_not_running", "uwp_frame_host_unsupported");
  if (!found) throw new ComputerError("app_not_running");
  if (isBlocked(ctx, found)) throw new ComputerError("app_blocked");
  if (!grantCovers(call.scope, found)) throw new ComputerError("app_not_granted");
  return found;
}

/** The window the model means among the app's usable windows. */
function pickWindow(all: WindowInfo[], window: string | undefined): WindowInfo | undefined {
  if (window) {
    const needle = window.toLowerCase();
    const found =
      all.find((w) => w.id === window) ?? all.find((w) => w.title.toLowerCase().includes(needle));
    // Localized titles need not resemble the app name; never guess among several windows.
    return found ?? (all.length === 1 ? all[0] : undefined);
  }
  // Apps also own untitled helper windows (tab strips, popovers, full-screen toolbars);
  // the document window is titled, sizeable and preferably visible on this Space.
  const score = (w: WindowInfo) =>
    (w.title ? 8 : 0) +
    (w.onScreen ? 4 : 0) +
    (w.onCurrentSpace ? 2 : 0) +
    (w.minimized ? 0 : 1) +
    (w.bounds.width >= 120 && w.bounds.height >= 80 ? 16 : 0);
  return all
    .slice()
    .sort(
      (a, b) =>
        score(b) - score(a) || b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height,
    )[0];
}

/** The window to act on: explicit id / title fragment, else the app's front visible window. */
export async function resolveWindow(
  ctx: ServiceContext,
  call: Call,
  app: AppInfo,
  window: string | undefined,
): Promise<WindowInfo> {
  const reused = ctx.windows?.has(app.pid) ?? false;
  let all = (await windowsOf(ctx, call.signal, app.pid)).filter(usable);
  let found = pickWindow(all, window);
  // A list read moments ago can be one window behind (a dialog just closed, a new one opened):
  // ask the OS again before answering that the app has no such window.
  if (!found && reused) {
    forgetWindows(ctx, app.pid);
    all = (await windowsOf(ctx, call.signal, app.pid)).filter(usable);
    found = pickWindow(all, window);
  }
  if (!found)
    throw new ComputerError(
      "window_not_found",
      window ? "no_such_window" : "app_has_no_open_window_open_one",
      undefined,
      undefined,
      window && all.length > 1
        ? {
            windows: all
              .filter((w) => !isBlockedWindow(app, w))
              .slice(0, 20)
              .map((w) => ({ id: w.id.slice(0, 200), title: w.title.slice(0, 200) })),
          }
        : undefined,
    );
  if (isBlockedWindow(app, found)) throw new ComputerError("app_blocked", "privacy_settings");
  return found;
}

export const windowKey = (window: Pick<WindowInfo, "pid" | "id">) => `${window.pid}:${window.id}`;

/**
 * Background tree reads and element actions on one app run one at a time: Cua
 * tokens are per snapshot, so interleaved reads from two runs would invalidate each other.
 */
export function createAppQueue() {
  const tails = new Map<number, Promise<unknown>>();
  return function serial<T>(pid: number, run: () => Promise<T>): Promise<T> {
    const previous = tails.get(pid) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.catch(() => {
      // Only ordering is chained here; the caller observes the error through `next`.
    });
    tails.set(pid, tail);
    void tail.then(() => {
      if (tails.get(pid) === tail) tails.delete(pid);
    });
    return next;
  };
}
