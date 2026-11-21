import { setTimeout } from "node:timers/promises";
import type { ComputerUiAction } from "@pibot/protocol-base";
import type {
  AppInfo as CuaAppInfo,
  CuaDriverLike,
  WindowInfo as CuaWindowInfo,
} from "@trycua/cua-driver";
import { ComputerError, notDelivered } from "../core/errors.ts";
import type {
  AppInfo,
  ComputerDriver,
  DriverFeatures,
  InstalledApp,
  KeysStep,
  Platform,
  Point,
  PointerStep,
  RawElement,
  SessionState,
  WindowCapture,
  WindowInfo,
} from "../core/types.ts";
import { type CuaArgs, type CuaClient, createCuaClient } from "../cua/client.ts";
import type { Cua } from "../cua/loader.ts";
import { assertAppShortcut, normalizedKeys } from "../guard/foreground.ts";
import { capturePrimaryDisplay } from "./display-capture.ts";

export interface CuaDriverOptions {
  platform: Platform;
  load(): Promise<Cua>;
  connect?(module: Cua): Promise<CuaDriverLike>;
  features: DriverFeatures;
  /**
   * How this platform names an app for grants (bundle id / exe name / app name). `apps` is the
   * whole list the row came from: Windows needs it to give a running packaged process the same
   * id (AUMID) as its installed row.
   */
  appId(app: CuaAppInfo, apps: readonly CuaAppInfo[]): string;
  /**
   * Completes Cua's app rows before anything names them (Windows: image paths of running
   * packaged apps). Every list goes through it, so all callers see the same identities.
   */
  enrichApps?(apps: readonly CuaAppInfo[], signal?: AbortSignal): Promise<CuaAppInfo[]>;
  session(signal?: AbortSignal): Promise<SessionState>;
  timeoutMs?: number;
}

const MODIFIERS = new Set(["cmd", "command", "ctrl", "control", "alt", "option", "shift", "fn"]);

/**
 * The running rows of one Cua app list, named by the platform's `appId`. Windows maps them itself
 * because a frame-hosted app's identity is proven by the installed rows of the same list, and a
 * second Cua call would cost another round trip.
 */
export function runningAppRows(
  apps: readonly CuaAppInfo[],
  appId: (app: CuaAppInfo, apps: readonly CuaAppInfo[]) => string,
): AppInfo[] {
  return apps
    .filter((a) => a.running && a.pid > 0)
    .map((a) => ({ id: appId(a, apps), name: a.name, pid: a.pid, active: a.active }));
}

function windowOf(w: CuaWindowInfo): WindowInfo {
  return {
    id: w.windowId.toString(),
    pid: w.pid ?? 0,
    title: w.title,
    bounds: { x: w.bounds.x, y: w.bounds.y, width: w.bounds.width, height: w.bounds.height },
    onScreen: w.isOnScreen,
    minimized: w.minimized ?? false,
    onCurrentSpace: w.onCurrentSpace ?? w.isOnScreen,
    layer: w.layer ?? 0,
    ...(w.zIndex == null ? {} : { z: Number(w.zIndex) }),
  };
}

/**
 * Why Cua returned no tree. Windows on another Space / full-screen app cannot be read in the
 * background; a just-launched app answers empty for a moment (ax_app_launching).
 */
function degraded(reason: string): ComputerError {
  const code = reason.replace(/[^a-z0-9_]/gi, "").slice(0, 60);
  // Cua cannot map a window id to its AX window. A just-created window settles within a
  // moment, which is why `waitUntilVisible` keeps polling on SETTLING details — keep that prefix
  // (`ax_window_unresolved`) so an app that is still starting up is retried instead of refused.
  // The lasting causes (Stage Manager's side strip, another desktop Space, anything else that keeps
  // the AX window away) are indistinguishable here: this layer only has the window id, and Stage
  // Manager is a user setting it does not read. So the detail names the symptom rather than guessing
  // one cause; failureText lists the common ones for the model.
  if (/unresolved/i.test(reason))
    return new ComputerError("needs_foreground", "ax_window_unresolved_background_unreadable");
  if (/space|offscreen|minimi/i.test(reason)) return new ComputerError("needs_foreground", code);
  if (/launch/i.test(reason)) return new ComputerError("driver_error", "app_launching_retry");
  if (/permission|trust/i.test(reason)) return new ComputerError("permission_missing", code);
  return new ComputerError("window_not_found", code);
}

/**
 * Why a window gave no picture, as a hint the model can act on (restore / open a window). The
 * owner's Notes screenshots failed this way as an opaque driver_error.
 */
function uncapturable(window: WindowInfo): string {
  if (window.minimized) return "window_minimized_restore_or_open_a_window";
  if (!window.onCurrentSpace) return "window_on_other_space_or_full_screen";
  if (!window.onScreen) return "window_hidden_or_closed_open_a_window";
  return "window_not_capturable";
}

function decodeBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

/**
 * The Cua-backed parts shared by every platform: apps, windows, tree, element actions,
 * window screenshots, keys and window-local pixel input. Platform files override what Cua
 * does badly there (macOS: coordinate clicks).
 */
export function createCuaComputerDriver(options: CuaDriverOptions) {
  let client: CuaClient | undefined;
  let starting: Promise<CuaClient> | undefined;
  // Cua pixel input is window-local in its own screenshot's pixels; remember each window's
  // pixels-per-point from the last capture so pointer steps need no extra capture.
  const scales = new Map<string, number>();

  const cua = async (): Promise<CuaClient> => {
    if (client?.retired) {
      const previous = client;
      await previous.shutdown();
      if (client === previous) client = undefined;
      scales.clear();
    }
    if (client) return client;
    starting ??= options.load().then(async (module) => {
      const driver = await options.connect?.(module);
      const raw = createCuaClient(module, { timeoutMs: options.timeoutMs, driver }).client;
      const enrich = options.enrichApps;
      // Only listApps changes; lifetime state (retired) and every other call stay the client's.
      const created: CuaClient = enrich
        ? Object.create(raw, {
            listApps: {
              value: async (signal?: AbortSignal) => {
                const out = await raw.listApps(signal);
                return { ...out, apps: await enrich(out.apps, signal) };
              },
            },
          })
        : raw;
      // Cua draws its own "agent cursor" overlay by default; Pi Bot has its own indicator.
      await created.tool("set_agent_cursor_enabled", { enabled: false }).catch(() => {
        // Older/newer builds may not know the switch; the overlay is cosmetic.
      });
      client = created;
      return created;
    });
    try {
      return await starting;
    } finally {
      starting = undefined;
    }
  };
  const target = (window: WindowInfo): CuaArgs => ({
    // A frame-hosted store app's window belongs to ApplicationFrameHost; native calls address it
    // through that process, while the app identity stays in `pid`.
    pid: window.hostPid ?? window.pid,
    window_id: BigInt(window.id),
  });
  const remember = (window: WindowInfo, pixelsWide: number) => {
    if (window.bounds.width > 0) scales.set(window.id, pixelsWide / window.bounds.width);
    if (scales.size > 64) scales.delete(scales.keys().next().value as string);
  };

  async function captureWindow(window: WindowInfo, signal?: AbortSignal): Promise<WindowCapture> {
    const c = await cua();
    let state: Awaited<ReturnType<CuaClient["windowState"]>>;
    try {
      state = await c.windowState(
        {
          pid: window.hostPid ?? window.pid,
          windowId: BigInt(window.id),
          tree: false,
          screenshot: true,
        },
        signal,
      );
    } catch (error) {
      if (error instanceof ComputerError && error.code === "window_not_found")
        throw new ComputerError("window_not_found", uncapturable(window), error.diagnostic);
      throw error;
    }
    const image = state.images[0];
    if (!image || !state.screenshotWidth || !state.screenshotHeight)
      throw new ComputerError(
        "window_not_found",
        uncapturable(window),
        `cua degraded: ${(state.degradedReason ?? "no_image").replace(/[^a-z0-9_ ]/gi, "").slice(0, 80)}`,
      );
    const bounds = state.windowBounds ?? window.bounds;
    remember({ ...window, bounds }, state.screenshotWidth);
    return {
      bytes: decodeBase64(image.dataBase64),
      mimeType: image.mimeType,
      pixels: { width: state.screenshotWidth, height: state.screenshotHeight },
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    };
  }

  async function localPixel(window: WindowInfo, at: Point, signal?: AbortSignal) {
    let scale = scales.get(window.id);
    if (scale === undefined) {
      await captureWindow(window, signal);
      scale = scales.get(window.id) ?? 1;
    }
    return { x: (at.x - window.bounds.x) * scale, y: (at.y - window.bounds.y) * scale };
  }

  const driver: ComputerDriver = {
    platform: options.platform,
    features: options.features,
    async unavailableReason(signal) {
      try {
        const c = await cua();
        await c.listWindows({ onScreenOnly: true }, signal);
        return undefined;
      } catch (error) {
        if (error instanceof ComputerError) return error.code;
        // Load/create failures (dlopen, non-interactive Windows session) arrive as plain errors.
        return "driver_unavailable";
      }
    },
    async listApps(signal) {
      const out = await (await cua()).listApps(signal);
      return runningAppRows(out.apps, options.appId);
    },
    // Windows / Linux: Cua's list includes installed, not running apps. The ids are checked
    // against Start-menu shortcuts / AUMIDs (Windows) and XDG .desktop ids (Linux).
    async installedApps(limit, signal) {
      const out = await (await cua()).listApps(signal);
      const seen = new Set<string>();
      const apps: InstalledApp[] = [];
      for (const a of out.apps) {
        const id = options.appId(a, out.apps);
        if (!id || seen.has(id.toLowerCase())) continue;
        seen.add(id.toLowerCase());
        apps.push({ id, name: a.name || id });
      }
      return { apps: apps.slice(0, limit), truncated: apps.length > limit };
    },
    async launchPath(appId, signal) {
      const out = await (await cua()).listApps(signal);
      const id = appId.toLowerCase();
      return (
        out.apps.find((a) => options.appId(a, out.apps)?.toLowerCase() === id)?.launchPath ??
        undefined
      );
    },
    async frontmostApp(signal) {
      return (await driver.listApps(signal)).find((a) => a.active) ?? null;
    },
    async windows(pid, signal) {
      const out = await (await cua()).listWindows({ pid, onScreenOnly: false }, signal);
      return out.windows.map(windowOf).filter((w) => w.pid === pid);
    },
    async onScreenWindows(signal) {
      const out = await (await cua()).listWindows({ onScreenOnly: true }, signal);
      return out.windows
        .slice()
        .sort((a, b) => Number((a.zIndex ?? 0n) - (b.zIndex ?? 0n)))
        .map(windowOf);
    },
    captureWindow,
    captureDisplay: async (index, signal) => capturePrimaryDisplay(await cua(), index, signal),
    async readTree(window, { maxNodes, maxDepth }, signal) {
      const readState = () =>
        cua().then((c) =>
          c.windowState(
            {
              pid: window.hostPid ?? window.pid,
              windowId: BigInt(window.id),
              tree: true,
              screenshot: false,
              maxElements: maxNodes,
              maxDepth,
            },
            signal,
          ),
        );
      let state = await readState();
      // Task asks about a window Cua cannot find yet (ax_window_unresolved). A window that was just
      // created is registered with the window server before Accessibility, and answers a moment
      // later; only a window in Stage Manager's side strip keeps failing. One short retry tells the
      // two apart, so "still starting up" is not reported as "cannot be read in the background".
      if (!(state.elements ?? []).length && /unresolved/i.test(state.degradedReason ?? "")) {
        // Cancellable: this wait sits inside an action the user can stop, and a bare timer would
        // keep the read alive for another 400 ms after that.
        await setTimeout(400, undefined, { signal });
        state = await readState();
      }
      const elements = (state.elements ?? []).map(
        (e): RawElement => ({
          token: e.elementToken,
          index: Number(e.elementIndex),
          parentIndex: e.parentIndex === undefined ? undefined : Number(e.parentIndex),
          depth: e.depth,
          role: e.role,
          label: e.label,
          value: e.value,
          valueDescription: e.valueDescription,
          enabled: e.enabled,
          selected: e.selected,
          actions: e.actions ?? [],
          frame: e.frame && { x: e.frame.x, y: e.frame.y, width: e.frame.w, height: e.frame.h },
        }),
      );
      if (!elements.length && state.degradedReason) throw degraded(state.degradedReason);
      const truncated = state.truncated === true || state.elementsComplete === false;
      const total = state.totalElementCount === undefined ? NaN : Number(state.totalElementCount);
      return {
        elements,
        truncated,
        ...(truncated
          ? {
              truncation: {
                reason: /max_elements|node|element_limit/i.test(state.truncationReason ?? "")
                  ? ("node_limit" as const)
                  : /depth/i.test(state.truncationReason ?? "")
                    ? ("depth_limit" as const)
                    : ("driver" as const),
                depthReached: elements.reduce((depth, e) => Math.max(depth, e.depth), 0),
                remainingNodes:
                  Number.isSafeInteger(total) && total >= elements.length
                    ? total - elements.length
                    : null,
              },
            }
          : {}),
      };
    },
    async uiAction(window, token, action: ComputerUiAction, value, signal) {
      const c = await cua();
      const press = (clickAction: string) =>
        c.tool(
          "click",
          {
            ...target(window),
            element_token: token,
            action: clickAction,
            delivery_mode: "background",
          },
          signal,
        );
      if (action === "press" || action === "focus" || action === "showMenu") {
        const result = await c.click(
          {
            target: { pid: window.hostPid ?? window.pid, windowId: BigInt(window.id) },
            position: { elementToken: token },
            delivery: "background",
            button: action === "showMenu" ? "right" : "left",
          },
          signal,
        );
        return result.effect === 0 ? "confirmed" : "unverified";
      }
      let result: Awaited<ReturnType<CuaClient["tool"]>>;
      switch (action) {
        case "select":
          // Windows never reaches this: its driver selects through UI Automation's SelectionItem
          // pattern instead, because this "pick" click moves the real pointer.
          result =
            value === undefined
              ? await press("pick")
              : await c.tool(
                  "set_value",
                  { ...target(window), element_token: token, value },
                  signal,
                );
          break;
        case "setValue":
          if (value === undefined) throw notDelivered("driver_error", "value_required");
          result = await c.tool(
            "set_value",
            { ...target(window), element_token: token, value },
            signal,
          );
          break;
        case "scrollTo":
          throw new ComputerError("unsupported", "scroll_to_use_pointer_scroll");
      }
      return result.action?.effect === 0 ? "confirmed" : "unverified";
    },
    // Cua 0.35.2 has invoke_menu on Windows / Linux too, but Pi Bot has only verified it on
    // macOS (invoke-menu probe); elsewhere the model uses keys for menu commands.
    async invokeMenu() {
      throw new ComputerError("unsupported", "menu_unsupported_on_this_platform");
    },
    async pointer(window, step: PointerStep, signal) {
      const mode = step.delivery === "foreground" ? "foreground" : "background";
      if (mode === "foreground")
        throw new ComputerError("unsupported", "foreground_occlusion_check_unavailable");
      const c = await cua();
      const at = await localPixel(window, step.at, signal);
      const base = {
        target: { kind: "window", ...target(window) },
        x: at.x,
        y: at.y,
        delivery_mode: mode,
      };
      switch (step.kind) {
        case "click":
        case "doubleClick":
        case "rightClick":
          await c.click(
            {
              target: { pid: window.hostPid ?? window.pid, windowId: BigInt(window.id) },
              position: at,
              delivery: mode,
              count: step.kind === "doubleClick" ? 2 : 1,
              button: step.kind === "rightClick" ? "right" : "left",
            },
            signal,
          );
          break;
        case "drag": {
          if (!step.to) throw notDelivered("driver_error", "drag_needs_to");
          const to = await localPixel(window, step.to, signal);
          await c.tool(
            "drag",
            {
              target: { kind: "window", ...target(window) },
              from_x: at.x,
              from_y: at.y,
              to_x: to.x,
              to_y: to.y,
              delivery_mode: mode,
            },
            signal,
          );
          break;
        }
        case "scroll": {
          const dy = step.dy ?? 0;
          const dx = step.dx ?? 0;
          const vertical = Math.abs(dy) >= Math.abs(dx);
          const amount = Math.max(1, Math.min(50, Math.abs(vertical ? dy : dx) || 3));
          const direction = vertical ? (dy < 0 ? "up" : "down") : dx < 0 ? "left" : "right";
          await c.tool("scroll", { ...base, direction, amount }, signal);
          break;
        }
        case "move":
          // Cua's move_cursor drives its overlay cursor, not a hover; nothing useful to offer.
          throw new ComputerError("unsupported", "move_unsupported");
      }
      return mode;
    },
    async keys(window, step: KeysStep, signal) {
      const c = await cua();
      const mode = step.delivery === "foreground" ? "foreground" : "background";
      if (mode === "foreground") assertAppShortcut(options.platform, step.combo);
      // Once one send succeeded, a later failure cannot be retried as a whole — the
      // text or key already went in, and repeating the call would type it twice.
      let sent = false;
      const send = async (name: string, args: CuaArgs) => {
        // A ComputerError, not the raw abort reason: the catch below turns a later failure into
        // "already delivered" only when it can see a ComputerError.
        if (signal?.aborted) throw new ComputerError("cancelled", "keys_aborted");
        // The app counts as frontmost through either process: a frame-hosted store app's window
        // is owned by ApplicationFrameHost but the foreground app is the hosted one.
        if (mode === "foreground") {
          const front = (await driver.frontmostApp(signal))?.pid;
          if (front !== window.pid && front !== window.hostPid)
            throw notDelivered("target_moved", "target_app_not_frontmost");
        }
        const result = await c.tool(
          name,
          args,
          signal,
          mode === "foreground" ? step.inject : undefined,
        );
        sent = true;
        return result;
      };
      const where: CuaArgs = step.elementToken
        ? {
            target: { kind: "window", ...target(window) },
            element_token: step.elementToken,
            delivery_mode: mode,
          }
        : { target: { kind: "window", ...target(window) }, delivery_mode: mode };
      try {
        if (step.text !== undefined) await send("type_text", { ...where, text: step.text });
        if (step.combo) {
          const keys = normalizedKeys(step.combo);
          const plain = keys.filter((k) => !MODIFIERS.has(k));
          if (plain.length !== 1) throw notDelivered("driver_error", "combo_needs_one_key");
          if (keys.length === 1) await send("press_key", { ...where, key: plain[0] });
          else
            await send("hotkey", {
              ...where,
              keys: [...keys.filter((k) => MODIFIERS.has(k)), plain[0]],
            });
        }
      } catch (error) {
        if (sent && error instanceof ComputerError)
          throw new ComputerError(
            error.code,
            error.detail,
            error.diagnostic,
            undefined,
            undefined,
            {
              delivered: "yes",
              retry: "unsafe",
            },
          );
        throw error;
      }
      return mode;
    },
    async secureFocus(_pid, _at, _signal, _windowId) {
      return "unknown";
    },
    session: (signal) => options.session(signal),
    async drain() {
      const current = client ?? (starting ? await starting : undefined);
      await current?.drain();
    },
    async release() {
      const current = client ?? (starting ? await starting : undefined);
      await current?.shutdown();
      if (client === current) client = undefined;
      scales.clear();
    },
  };
  /** Cua's invoke_menu on this window's app (background; never activates the app). */
  async function invokeMenu(window: WindowInfo, path: string[], signal?: AbortSignal) {
    const result = await (await cua()).tool("invoke_menu", { ...target(window), path }, signal);
    // Cua reports a menu press as "unverifiable" (it cannot see what the command did).
    return result.action?.effect === 0 ? ("confirmed" as const) : ("unverified" as const);
  }

  return { driver, cua, captureWindow, localPixel, invokeMenu };
}
