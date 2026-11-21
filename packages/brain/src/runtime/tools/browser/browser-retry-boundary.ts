import type { ToolRunContext } from "../../../core/local-types.ts";

export const BROWSER_TAKEOVER_STOP =
  "用户正在接管浏览器，本轮停止浏览器操作。保留产物和入口并告诉用户当前结果；不要 sleep 等待、反复调用或换端口/重启服务绕过接管。用户交还后可在新的运行中继续 / The user controls the browser. Stop browser actions for this turn, preserve and report outputs/entry points. Do not sleep, retry or change ports/restart services to evade takeover. A new run can continue after hand-back.";
export const BROWSER_SCREENSHOT_STOP =
  "截图不可用，本轮不再重复截图。可用页面快照读取内容，但不能当成视觉验证；如实交付已生成的文件和入口，说明未视觉核验，不要 sleep 等待、重启服务或反复重开页面只为截图 / Screenshot unavailable; do not repeat screenshots this turn. A page snapshot can read content but is not visual verification. Deliver existing files/entry points and disclose the missing visual check. Do not sleep, restart services or repeatedly reopen pages just to capture.";

/** The host already retried each miss once; the second miss in a turn ends screenshots. */
const SCREENSHOT_MISSES = 2;

export function browserRetryBoundary(context: ToolRunContext, tool: string) {
  const failures = context.browserFailures;
  if (failures?.takeover) return BROWSER_TAKEOVER_STOP;
  if (tool === "browser_screenshot" && failures?.screenshot) return BROWSER_SCREENSHOT_STOP;
  // Step thumbnails stop after their own miss or when the model's screenshots did.
  if (tool === "step_picture" && (failures?.screenshot || failures?.stepPictures))
    return BROWSER_SCREENSHOT_STOP;
  return undefined;
}

/** The one thing a takeover boundary needs from the service: mirror the pause right there. */
export interface ParentPauseSink {
  noteParentContinuation(context: ToolRunContext): void;
}

/** The next user run gets fresh state; an LLM retry cannot clear a host ownership failure. */
export function stopBrowserRetries(
  sink: ParentPauseSink,
  context: ToolRunContext,
  reason: "takeover" | "screenshot" | "step_picture",
) {
  context.browserFailures ??= {};
  const failures = context.browserFailures;
  if (reason === "step_picture") {
    failures.stepPictures = true;
    return;
  }
  if (reason === "screenshot") {
    failures.screenshotMisses = (failures.screenshotMisses ?? 0) + 1;
    if (failures.screenshotMisses < SCREENSHOT_MISSES) return;
  }
  failures[reason] = true;
  if (reason !== "takeover" || !context.todoRun?.armed) return;
  context.todoRun.paused ??= { reason: "browser_takeover", summary: "" };
  // Persist at the boundary: the model may keep generating, and a crash before the turn ends
  // would otherwise leave the durable row saying "not paused".
  sink.noteParentContinuation(context);
}
