import { type Call, type ServiceContext, windowKey } from "../core/context.ts";
import { ComputerError } from "../core/errors.ts";
import type { Rect, WindowInfo } from "../core/types.ts";
import type { ElementFacts } from "./tree.ts";

export const TEXT_ROLE = /text|combo|search/i;
export const near = (a: Rect, b: Rect) =>
  Math.abs(a.x - b.x) <= 2 &&
  Math.abs(a.y - b.y) <= 2 &&
  Math.abs(a.width - b.width) <= 2 &&
  Math.abs(a.height - b.height) <= 2;

/** A negative scan cannot authorize input; retaining it avoids another doomed full walk. */
export function invalidateSecureScans(ctx: ServiceContext) {
  for (const [key, scan] of ctx.secureScans ?? []) if (scan.complete) ctx.secureScans?.delete(key);
}

const incomplete = () =>
  new ComputerError(
    "secure_scan_incomplete",
    "无法确认实际输入焦点不是密码框，请重新读取指定窗口或请用户接管 / " +
      "Cannot verify the actual input focus is not a password field; read the specific window again or ask the user to take over",
  );

/** A partial tree cannot certify a receiver: focus it first, then ask the OS about that focus. */
export async function confirmUnscannedInput(
  ctx: ServiceContext,
  call: Call,
  window: WindowInfo,
  elementId?: string,
  facts?: ElementFacts,
) {
  // A token that survived re-reads carries its own verdict (see ElementFacts.secureUnverified);
  // the window-wide flag only speaks for input that names no element.
  const snapshot = ctx.elements.get(windowKey(window));
  if (
    facts ? !TEXT_ROLE.test(facts.role) || !facts.secureUnverified : !snapshot?.secureScanIncomplete
  )
    return;
  if (facts?.secure) throw new ComputerError("secure_field");
  if (!ctx.driver.focusedInput || (facts && !facts.frame)) throw incomplete();
  try {
    if (elementId) await ctx.driver.uiAction(window, elementId, "focus", undefined, call.signal);
    call.signal.throwIfAborted();
    const focus = await ctx.driver.focusedInput(window.pid, call.signal);
    call.signal.throwIfAborted();
    if (
      focus?.secure ||
      focus?.role === "AXSecureTextField" ||
      focus?.subrole === "AXSecureTextField"
    )
      throw new ComputerError("secure_field");
    if (!focus) throw incomplete();
    const frame = focus.frame;
    const bounds = window.bounds;
    const matches = facts?.frame
      ? near(frame, facts.frame)
      : frame.x >= bounds.x &&
        frame.y >= bounds.y &&
        frame.x + frame.width <= bounds.x + bounds.width &&
        frame.y + frame.height <= bounds.y + bounds.height;
    if (!matches) throw incomplete();
  } catch (error) {
    call.signal.throwIfAborted();
    if (
      error instanceof ComputerError &&
      (error.code === "secure_field" || error.code === "cancelled")
    )
      throw error;
    // Native diagnostics may include UI text; failed confirmation has only a fixed refusal.
    throw incomplete();
  }
}
