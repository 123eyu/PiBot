import { setImmediate } from "node:timers/promises";
import type { RoutineRunStatus } from "@pibot/protocol";
import type { RoutineRunsRepo } from "../../store/index.ts";

// Cursor scope excludes mutable status, so settling a page's last record cannot truncate the scan.
export async function* routineRunPages(
  runs: RoutineRunsRepo,
  status: RoutineRunStatus,
  signal: AbortSignal,
  routineId?: string,
) {
  let before: string | undefined;
  for (;;) {
    signal.throwIfAborted();
    const page = runs.page(status, { before, limit: 200 }, routineId);
    for (const [i, record] of page.entries()) {
      if (i % 32 === 0) await setImmediate(undefined, { signal });
      signal.throwIfAborted();
      yield record;
    }
    if (page.length < 200) return;
    before = page.at(-1)?.id;
  }
}
