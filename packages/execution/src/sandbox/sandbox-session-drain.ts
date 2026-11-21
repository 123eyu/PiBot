import { setTimeout as delay } from "node:timers/promises";

/** Diagnostic grace only; the caller still owns killing and verifying the remaining group. */
export async function waitForSessionChildren(
  members: (timeout: number) => number,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = performance.now() + 2000;
  let remaining = members(2000);
  while (remaining > 0 && !signal.aborted && performance.now() < deadline) {
    try {
      // Each check spawns ps (~10 ms): 100 ms keeps the grace cheap while still ending early.
      await delay(Math.min(100, deadline - performance.now()), undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
      // Cancellation ends the diagnostic grace, never the caller's group cleanup.
      return false;
    }
    if (signal.aborted || performance.now() >= deadline) break;
    remaining = members(Math.max(1, Math.ceil(deadline - performance.now())));
  }
  return remaining === 0;
}
