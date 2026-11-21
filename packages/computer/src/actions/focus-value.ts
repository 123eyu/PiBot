import type { Call, ServiceContext } from "../core/context.ts";
import type { WindowInfo } from "../core/types.ts";

/** A readback failure must never turn an already sent key into a retryable failed action. */
export async function focusValue(ctx: ServiceContext, call: Call, window: WindowInfo) {
  if (!ctx.driver.focusedValue || call.signal.aborted) return undefined;
  try {
    const result = await ctx.driver.focusedValue(
      window,
      AbortSignal.any([call.signal, AbortSignal.timeout(1500)]),
    );
    call.signal.throwIfAborted();
    if (!result || result.secure || /secure|password/i.test(`${result.role} ${result.subrole}`))
      return undefined;
    const frame = result.frame;
    const bounds = window.bounds;
    if (
      frame.x < bounds.x ||
      frame.y < bounds.y ||
      frame.x + frame.width > bounds.x + bounds.width ||
      frame.y + frame.height > bounds.y + bounds.height
    )
      return undefined;
    return result.value;
  } catch {
    // Optional observation only; the key dispatch already succeeded and must not be replayed.
    return undefined;
  }
}
