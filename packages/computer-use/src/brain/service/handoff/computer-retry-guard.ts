import type { ComputerRunContext } from "@pibot/brain/kit";

/** Identical failures in a row after which the run stops calling the host for that call. */
export const COMPUTER_RETRY_LIMIT = 3;

const STOP_TEXT =
  "同一个操作已经连续失败 3 次，结果不会自己变好。不要再重试同样的调用：换一个办法（例如先读界面树、打开或恢复窗口），或者停下来告诉用户失败原因并请用户处理 / " +
  "This exact call has failed 3 times in a row and will not start working by itself. Do not retry it: try something different (e.g. read the UI tree, open or restore a window), or stop and tell the user what failed and ask them to handle it";

/**
 * Stops a model from looping on one failing computer call (the owner's run retried a failing
 * Notes screenshot 26+ times over 15 minutes). A streak is the same tool on the same app with
 * the same failure code; any success or any different call starts over. Once the streak
 * reaches the limit, further identical calls are answered here without reaching the host.
 */
export function computerRetryGuard(
  context: ComputerRunContext,
  tool: string,
  app: string | undefined,
) {
  const key = `${tool}\u0000${(app ?? "").toLowerCase()}`;
  const streak = context.computerFailures;
  const repeating = streak?.key === key && streak.count >= COMPUTER_RETRY_LIMIT;
  if (streak && streak.key !== key) context.computerFailures = undefined;
  return {
    /** Text to return instead of calling the host, when this call is already known to fail. */
    blocked: repeating ? `${STOP_TEXT} (${streak.code})` : undefined,
    /** Feed every host result of this tool call (a foreground retry counts as the same call). */
    observe(result: { ok: true } | { ok: false; code: string }) {
      if (result.ok) {
        context.computerFailures = undefined;
        return;
      }
      // Waiting for the user's foreground answer is part of the call, not a failure.
      if (result.code === "needs_foreground" || result.code === "cancelled") return;
      const current = context.computerFailures;
      context.computerFailures =
        current?.key === key && current.code === result.code
          ? { ...current, count: current.count + 1 }
          : { key, code: result.code, count: 1 };
    },
    /**
     * This call's streak after `observe` (identical failures in a row, and whether a
     * "come help" card was already shown for it), or undefined when `code` does not continue it.
     */
    streak(code: string) {
      const current = context.computerFailures;
      return current?.key === key && current.code === code ? current : undefined;
    },
    /** Appends the stop instruction to the failure that completes a streak. */
    annotate(text: string): string {
      const current = context.computerFailures;
      return current?.key === key && current.count >= COMPUTER_RETRY_LIMIT
        ? `${text}\n${STOP_TEXT}`
        : text;
    },
  };
}
