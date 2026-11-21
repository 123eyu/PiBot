import type { PolicyRequest } from "@pibot/policy";
import { ComputerAppIdSchema } from "@pibot/protocol-base";

/** The operating-the-computer tools (browser_* tools are web, not these). */
export const COMPUTER_TOOLS = new Set([
  "screenshot",
  "ui_tree",
  "ui_action",
  "pointer",
  "keys",
  "open_app",
  "open_file",
]);
export function isComputerTool(tool: string): boolean {
  return COMPUTER_TOOLS.has(tool);
}

export type ComputerTarget =
  | { ok: true; apps: string[]; coordinates: boolean; byName: boolean }
  | { ok: false; reason: string };

/**
 * What a call needs a grant for. The tool input names the target app in `app` (an app ID; for
 * `open_app` an ID or a display name, resolved by the gate). A whole-display screenshot and every
 * pointer call are screenshot clicks: never covered by "always".
 */
export function computerTarget(tool: string, input: Record<string, unknown>): ComputerTarget {
  const raw = typeof input.app === "string" ? input.app.trim() : undefined;
  const app = raw && ComputerAppIdSchema.safeParse(raw).success ? raw : undefined;
  if (raw !== undefined && !app)
    return { ok: false, reason: "应用标识无效 / Invalid app identifier" };
  if (tool === "screenshot")
    return { ok: true, apps: app ? [app] : [], coordinates: !app, byName: false };
  if (!app)
    return {
      ok: false,
      reason:
        tool === "open_file"
          ? "请用 app 指定用哪个应用打开文件 / Name the app that should open the file in `app`"
          : "请用 app 指定要操作的应用 / Name the target app in `app`",
    };
  return { ok: true, apps: [app], coordinates: tool === "pointer", byName: tool === "open_app" };
}

/** The policy request for one call; `policyRequest` uses this for the seven tools. */
export function computerPolicyRequest(
  tool: string,
  input: Record<string, unknown>,
  alwaysApps?: readonly string[],
): PolicyRequest {
  const target = computerTarget(tool, input);
  return {
    category: "computer",
    tool,
    ...(target.ok ? { apps: target.apps, coordinates: target.coordinates } : {}),
    ...(alwaysApps ? { alwaysApps: [...alwaysApps] } : {}),
  };
}
