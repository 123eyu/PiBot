import type {
  ActionResult,
  CuaDriverLike,
  ListAppsOutput,
  ListWindowsOutput,
  ToolResult,
  WindowStateOutput,
} from "@trycua/cua-driver";
import {
  ComputerError,
  DEFAULT_CALL_TIMEOUT_MS,
  deliveryUnknown,
  scrubDriverText,
} from "../core/errors.ts";
import type { InputInjection } from "../core/types.ts";
import { serializeCuaArgs } from "./arguments.ts";
import { fromThrown, toComputerError } from "./errors.ts";

export { fromThrown, toComputerError } from "./errors.ts";

import { createCuaLifetime } from "./lifetime.ts";
import type { Cua } from "./loader.ts";

/**
 * Pi Bot only uses Cua's interface and input tools. Anything that starts or kills
 * processes, installs software, runs scripts, records, or drives a browser over CDP
 * (launch_app, kill_app, install_ffmpeg, run_script, run_steps, page, browser_*, recording,
 * parse_visual_regions, clipboard_*, set_config, set_window_frame) is never reachable.
 */
export const CUA_TOOL_WHITELIST = new Set([
  "list_apps",
  "list_windows",
  "get_window_state",
  "get_desktop_state",
  "get_screen_size",
  "check_permissions",
  "health_report",
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  // Presses one item of the app's own menu bar by its path, through Accessibility; it
  // starts nothing and never falls back to pixels. Pi Bot refuses the Apple and Services menus.
  "invoke_menu",
  // Raises one window for a foreground step the user agreed to; starts nothing.
  "bring_to_front",
  "set_agent_cursor_enabled",
]);

/**
 * Tools that put input into the app. Once one of these reached the
 * driver, a failure may have injected part of the input, so it cannot claim "nothing was
 * delivered" unless the driver refused before acting.
 */
const INPUT_TOOLS: ReadonlySet<string> = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "invoke_menu",
]);

export type CuaArgs = Record<string, unknown>;

export interface CuaClick {
  target: { pid: number; windowId: bigint };
  position: { x: number; y: number } | { elementToken: string };
  delivery: "background" | "foreground";
  button?: "left" | "right";
  count?: number;
}

export interface CuaClient {
  readonly retired: boolean;
  listApps(signal?: AbortSignal): Promise<ListAppsOutput>;
  listWindows(
    input: { pid?: number; onScreenOnly: boolean },
    signal?: AbortSignal,
  ): Promise<ListWindowsOutput>;
  windowState(
    input: {
      pid: number;
      windowId: bigint;
      tree: boolean;
      screenshot: boolean;
      maxElements?: number;
      maxDepth?: number;
    },
    signal?: AbortSignal,
  ): Promise<WindowStateOutput>;
  click(input: CuaClick, signal?: AbortSignal): Promise<ActionResult>;
  /** Whitelisted tool by name; a tool error becomes a ComputerError. */
  tool(
    name: string,
    args: CuaArgs,
    signal?: AbortSignal,
    inject?: InputInjection,
  ): Promise<ToolResult>;
  drain(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Wraps one CuaDriver instance: whitelist, a per-call timeout (default 15 s; external
 * displays and other Spaces can be very slow) and the caller's AbortSignal.
 */
export function createCuaClient(
  cua: Cua,
  options: { timeoutMs?: number; driver?: CuaDriverLike } = {},
): { client: CuaClient; driver: CuaDriverLike } {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const driver =
    options.driver ??
    cua.CuaDriver.create({
      ...cua.DriverOptions.new({ claudeCodeCompatibility: false }),
      embedded: true,
    });
  const lifetime = createCuaLifetime(driver, timeoutMs);
  const allow = (name: string) => {
    if (!CUA_TOOL_WHITELIST.has(name)) throw new ComputerError("unsupported", `tool_${name}`);
  };
  const call = <T>(
    name: string,
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
    input = false,
  ) => {
    allow(name);
    return lifetime.call(`cua.${name}`, signal, run).catch((error: unknown) => {
      const mapped = error instanceof ComputerError ? error : fromThrown(error);
      // A timeout, a cancelled call or a driver error on an input tool may have
      // injected part of the input. Only a refusal raised before the call (which carries its
      // own disposition) may say nothing was delivered; the rest must be checked on screen.
      if (input && !mapped.disposition)
        throw deliveryUnknown(mapped.code, mapped.detail, mapped.diagnostic);
      throw mapped;
    });
  };
  const client: CuaClient = {
    get retired() {
      return lifetime.retired;
    },
    listApps: (signal) =>
      call("list_apps", signal, () => driver.listApps(cua.ListAppsInput.new({}))),
    listWindows: (input, signal) =>
      call("list_windows", signal, () => driver.listWindows(cua.ListWindowsInput.new(input))),
    windowState: (input, signal) =>
      call("get_window_state", signal, () =>
        driver.getWindowState(
          cua.GetWindowStateInput.new({
            pid: input.pid,
            windowId: input.windowId,
            includeAccessibilityTree: input.tree,
            includeScreenshot: input.screenshot,
            treeFormat: "elements",
            ...(input.maxElements ? { maxElements: input.maxElements } : {}),
            ...(input.maxDepth ? { maxDepth: input.maxDepth } : {}),
            // Cua's own read budget defaults to 1 s and truncates Finder-sized trees; keep it
            // under our call timeout so a slow window degrades to "truncated", not "timeout".
            timeoutMs: Math.max(1000, timeoutMs - 3000),
          }),
        ),
      ),
    click: async (input, signal) => {
      const result = await call(
        "click",
        signal,
        () =>
          driver.click(
            cua.ClickInput.new({
              target: cua.ActionTarget.Window.new(input.target),
              position:
                "elementToken" in input.position
                  ? cua.ClickPosition.Element.new(input.position)
                  : cua.ClickPosition.Coordinates.new(input.position),
              deliveryMode:
                input.delivery === "background"
                  ? cua.InputDeliveryMode.Background
                  : cua.InputDeliveryMode.Foreground,
              ...(input.button === undefined
                ? {}
                : {
                    button: input.button === "right" ? cua.ClickButton.Right : cua.ClickButton.Left,
                  }),
              ...(input.count === undefined ? {} : { count: input.count }),
            }),
          ),
        true,
      );
      if (result.effect === cua.ActionEffect.Refused)
        throw toComputerError(result.error?.code ?? "action_refused", "");
      // An unexpected foreground receipt may already have injected input; never retry it.
      if (
        input.delivery === "background" &&
        result.delivery?.mode === cua.ActionDeliveryMode.Foreground
      )
        throw deliveryUnknown("driver_error", "unexpected_foreground_delivery");
      return result;
    },
    tool: async (name, args, signal, inject) => {
      const native = () => driver.callTool(name, serializeCuaArgs(args));
      const input = INPUT_TOOLS.has(name);
      const result = await call(name, signal, () => (inject ? inject(native) : native()), input);
      const refused = result.action?.effect === cua.ActionEffect.Refused;
      if (result.isError || refused) {
        const error = toComputerError(
          result.errorCode ??
            result.action?.error?.code ??
            (refused ? "action_refused" : undefined),
          result.text,
          `cua ${name}/${result.errorCode ?? ""}: ${scrubDriverText(result.text)}`,
        );
        // An explicit Refused effect proves the driver did not act. A bare error result on an
        // input tool does not: the input may have been partly injected before it failed.
        if (result.isError && !refused && input)
          throw deliveryUnknown(error.code, error.detail, error.diagnostic);
        throw error;
      }
      if (
        args.delivery_mode === "background" &&
        result.action?.delivery?.mode === cua.ActionDeliveryMode.Foreground
      )
        throw deliveryUnknown("driver_error", "unexpected_foreground_delivery");
      return result;
    },
    drain: lifetime.drain,
    shutdown: lifetime.shutdown,
  };
  return { client, driver };
}
