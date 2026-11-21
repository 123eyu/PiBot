import { homedir } from "node:os";
import { join } from "node:path";
import { ComputerAppIdSchema } from "@pibot/protocol-base";
import { z } from "zod";
import { ComputerError, notDelivered } from "../core/errors.ts";
import type {
  AppInfo,
  ComputerDriver,
  InstalledApp,
  Point,
  PointerStep,
  WindowInfo,
} from "../core/types.ts";
import type { Cua } from "../cua/loader.ts";
import { createCuaComputerDriver } from "./cua-driver.ts";
import { supplementCalculatorDisplay } from "./mac-display-read.ts";
import { createMacWorker, type MacWorker } from "./mac-worker.ts";

interface ScreenWindow {
  id: string;
  pid: number;
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowAt {
  pid: number;
  windowId: string;
  layer: number;
}

const FocusedInputSchema = z.strictObject({
  role: z.string().min(1).max(200),
  subrole: z.string().max(200),
  secure: z.boolean(),
  frame: z.strictObject({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().positive().finite(),
    height: z.number().positive().finite(),
  }),
});
const FocusedValueSchema = FocusedInputSchema.extend({ value: z.string().max(2000).optional() });

/**
 * What holds the keyboard, not just whether it is a password field. `focus` is the
 * focused element's own kind, because a boolean "not a password field" cannot be told apart from
 * "the app did not report a focus at all" — and free-form keys go to whatever really has focus.
 */
const SecureFocusSchema = z.strictObject({
  secure: z.boolean(),
  focus: z.enum(["text", "other", "none"]),
  hit: z.boolean(),
});

const ScanSchema = z.strictObject({
  frames: z.array(FocusedInputSchema.shape.frame).max(1500),
  complete: z.boolean(),
  timing: z
    .strictObject({
      windowMs: z.number().finite().nonnegative(),
      attributesMs: z.number().finite().nonnegative(),
      queueMs: z.number().finite().nonnegative(),
    })
    .optional(),
});

/**
 * macOS: Cua for apps' trees, element actions, window screenshots and keys; the
 * resident JXA helper for app list, lock state, HID idle, password-field checks and all
 * coordinate input. Background coordinate clicks go to the target pid with Cua's
 * window-routing fields; they only work on a visible target, so an occluded point, drags and
 * hovers return needs_foreground and the caller turns them into a foreground step.
 */
export function createMacDriver(options: {
  load(): Promise<Cua>;
  connect?(module: Cua): Promise<import("@trycua/cua-driver").CuaDriverLike>;
  timeoutMs?: number;
  worker?: MacWorker;
}): ComputerDriver {
  const worker = options.worker ?? createMacWorker({ timeoutMs: options.timeoutMs });
  const session = async (signal?: AbortSignal) => {
    const s = await worker.call<{ hid: number; locked: boolean }>("session", {}, signal);
    return { hidIdleSeconds: Math.max(0, Number(s.hid) || 0), locked: s.locked === true };
  };
  const base = createCuaComputerDriver({
    platform: "darwin",
    load: options.load,
    connect: options.connect,
    timeoutMs: options.timeoutMs,
    features: {
      backgroundClick: true,
      backgroundDrag: false,
      backgroundKeys: true,
      secureTree: true,
    },
    appId: (app) => app.bundleId ?? app.name,
    session,
  });
  const cua = base.driver;

  const topWindowAt = (at: Point, signal?: AbortSignal) =>
    worker.call<WindowAt | null>("windowAt", { x: at.x, y: at.y }, signal);

  async function visibleAt(window: WindowInfo, at: Point, signal?: AbortSignal) {
    const top = await topWindowAt(at, signal);
    return top !== null && top.pid === window.pid && top.windowId === window.id;
  }

  /** Raises the exact window; only for foreground steps the user agreed to. */
  async function raise(window: WindowInfo, signal?: AbortSignal) {
    const c = await base.cua();
    try {
      await c.tool("bring_to_front", { pid: window.pid, window_id: BigInt(window.id) }, signal);
    } catch (error) {
      // Cua refuses windows on another Space / behind a full-screen app;
      // activating the app and AXRaise-ing the window lets macOS switch Spaces itself.
      if (!(error instanceof ComputerError) || error.code === "cancelled") throw error;
      await worker.call("raise", { pid: window.pid, ...window.bounds }, signal);
    }
  }

  async function foreground(window: WindowInfo, step: PointerStep, signal?: AbortSignal) {
    if ((await session(signal)).locked) throw new ComputerError("screen_locked");
    if (!(await visibleAt(window, step.at, signal))) {
      await raise(window, signal);
      // Space switches animate; give the window up to ~1.5 s to become the top one.
      let visible = false;
      for (let i = 0; i < 6 && !visible; i++) {
        if (i) await new Promise((resolve) => setTimeout(resolve, 250));
        visible = await visibleAt(window, step.at, signal);
      }
      if (!visible) throw notDelivered("target_moved", "still_occluded_after_raise");
    }
    if (step.to && !(await visibleAt(window, step.to, signal)))
      throw notDelivered("target_moved", "drag_destination_occluded");
    const { x, y } = step.at;
    const input = (op: string, args: Record<string, unknown>) =>
      worker.call(op, args, signal, step.inject);
    switch (step.kind) {
      case "click":
        await input("click", { x, y, count: 1 });
        break;
      case "doubleClick":
        await input("click", { x, y, count: 2 });
        break;
      case "rightClick":
        await input("click", { x, y, count: 1, button: "right" });
        break;
      case "drag":
        if (!step.to) throw notDelivered("driver_error", "drag_needs_to");
        await input("drag", { x, y, toX: step.to.x, toY: step.to.y });
        break;
      case "move":
        await input("move", { x, y });
        break;
      case "scroll":
        {
          const at = await base.localPixel(window, step.at, signal);
          const dx = step.dx ?? 0,
            dy = step.dy ?? 0;
          const vertical = Math.abs(dy) >= Math.abs(dx);
          await (await base.cua()).tool(
            "scroll",
            {
              target: { kind: "window", pid: window.pid, window_id: BigInt(window.id) },
              x: at.x,
              y: at.y,
              delivery_mode: "foreground",
              direction: vertical ? (dy < 0 ? "up" : "down") : dx < 0 ? "left" : "right",
              amount: Math.max(1, Math.min(50, Math.abs(vertical ? dy : dx) || 3)),
            },
            signal,
            step.inject,
          );
        }
        break;
    }
    return "foreground" as const;
  }

  return {
    ...cua,
    async listApps(signal) {
      const apps = await worker.call<AppInfo[]>("apps", {}, signal);
      return apps.filter((a) => a.pid > 0).map((a) => ({ ...a, id: a.id || a.name }));
    },
    async readTree(window, limits, signal) {
      const read = await cua.readTree(window, limits, signal);
      return supplementCalculatorDisplay(read, window, limits, worker, signal);
    },
    async resolveAppName(name, signal) {
      const result = ComputerAppIdSchema.nullable().safeParse(
        await worker.call<unknown>("resolveAppName", { name }, signal),
      );
      if (!result.success) throw new ComputerError("driver_error", "app_name_resolution_invalid");
      return result.data ?? undefined;
    },
    installedApps(limit, signal) {
      const dirs = [
        "/Applications",
        "/System/Applications",
        join(homedir(), "Applications"),
        "/System/Library/CoreServices/Applications",
        // Finder sits directly in CoreServices, next to hundreds of agents that are not targets.
        "/System/Library/CoreServices/Finder.app",
      ];
      return worker.call<{ apps: InstalledApp[]; truncated: boolean }>(
        "installed",
        { dirs, limit },
        signal,
      );
    },
    async frontmostApp(signal) {
      const app = await worker.call<AppInfo | null>("frontmost", {}, signal);
      return app && { ...app, id: app.id || app.name };
    },
    async invokeMenu(window, path, delivery, signal) {
      if (delivery !== "foreground")
        return { effect: await base.invokeMenu(window, path, signal), delivery: "background" };
      if ((await session(signal)).locked) throw new ComputerError("screen_locked");
      await raise(window, signal);
      // Items a background app shows disabled are validated against the key window, which it
      // only gets once active; activation is asynchronous, so wait (bounded) until it is front.
      for (let i = 0; i < 6; i++) {
        if ((await worker.call<AppInfo | null>("frontmost", {}, signal))?.pid === window.pid) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return { effect: await base.invokeMenu(window, path, signal), delivery: "foreground" };
    },
    async pointer(window, step, signal) {
      if (step.delivery === "foreground") return foreground(window, step, signal);
      if (step.kind === "scroll") return cua.pointer(window, step, signal);
      if (step.kind !== "click" && step.kind !== "doubleClick")
        throw new ComputerError("needs_foreground", "background_unsupported");
      if (window.minimized || !window.onCurrentSpace)
        throw new ComputerError("needs_foreground", "window_not_visible");
      if (!(await visibleAt(window, step.at, signal)))
        throw new ComputerError("needs_foreground", "target_occluded");
      await worker.call(
        "stampedClick",
        {
          pid: window.pid,
          windowId: window.id,
          x: step.at.x,
          y: step.at.y,
          count: step.kind === "doubleClick" ? 2 : 1,
        },
        signal,
      );
      return "background";
    },
    // Cua lists only layer-0 windows; masking needs everything on screen, so the
    // window server's list gives order and geometry and Cua's adds titles (privacy settings).
    async onScreenWindows(signal) {
      const [all, titled] = await Promise.all([
        worker.call<ScreenWindow[]>("screenWindows", {}, signal),
        cua.onScreenWindows(signal),
      ]);
      const titles = new Map(titled.map((w) => [w.id, w.title]));
      return all.reverse().map(
        (w, z): WindowInfo => ({
          id: w.id,
          pid: w.pid,
          title: titles.get(w.id) ?? "",
          bounds: { x: w.x, y: w.y, width: w.width, height: w.height },
          onScreen: true,
          minimized: false,
          onCurrentSpace: true,
          layer: w.layer,
          z,
        }),
      );
    },
    async secureFrames(pid, window, signal) {
      const result = ScanSchema.safeParse(
        await worker.call<unknown>(
          "secureFrames",
          { pid, maxNodes: 1500, budgetMs: 2500, ...(window ? { window } : {}) },
          signal,
        ),
      );
      if (!result.success) throw new ComputerError("driver_error", "secure_scan_invalid");
      return result.data;
    },
    async secureFocus(pid, at, signal) {
      const result = SecureFocusSchema.safeParse(
        await worker.call<unknown>("secureFocus", at ? { pid, x: at.x, y: at.y } : { pid }, signal),
      );
      // An answer the helper could not produce is no evidence about the field: fail closed.
      if (!result.success) return "unknown";
      const answer = result.data;
      if (answer.secure) return true;
      // A point speaks about the control the caller is acting on, also while the app
      // reports no focus — the element path needs that, since it types into the element itself.
      if (at && answer.hit) return false;
      // Free-form keys go to whatever really has the keyboard. Only a proven text input
      // may receive them; "not a password field" for an element this process cannot see (or for a
      // button, or for no focus at all) is not proof, and MAC2 measured keys landing in a
      // password field that way.
      return answer.focus === "text" ? false : "unknown";
    },
    async focusedInput(pid, signal) {
      const result = FocusedInputSchema.safeParse(
        await worker.call<unknown>("focusedInput", { pid }, signal),
      );
      return result.success ? result.data : null;
    },
    async focusedValue(window, signal) {
      const result = FocusedValueSchema.safeParse(
        await worker.call<unknown>(
          "focusedValue",
          { pid: window.pid, window: window.bounds },
          signal,
        ),
      );
      return result.success ? result.data : null;
    },
    session,
    async drain() {
      await Promise.all([cua.drain?.(), worker.drain?.()]);
    },
    async release() {
      await Promise.all([cua.release(), worker.release()]);
    },
  };
}
