import { z } from "zod";
import { ComputerError } from "../core/errors.ts";
import type { ComputerDriver, DisplayReadDiagnostic, WindowInfo } from "../core/types.ts";
import type { MacWorker } from "./mac-worker.ts";

const DisplayDiagnosticSchema = z.strictObject({
  reason: z.enum([
    "read",
    "no_values",
    "not_calculator",
    "window_limit",
    "window_missing",
    "window_ambiguous",
    "role_missing",
    "children_invalid",
    "identity_changed",
    "attribute_unavailable",
    "bridge_failed",
    "time_limit",
    "node_limit",
    "depth_limit",
  ]),
  visited: z.number().int().min(0).max(2000),
  found: z.number().int().min(0).max(32),
  axStatus: z.number().int(),
});
const StaticTextSchema = z.strictObject({
  diagnostic: DisplayDiagnosticSchema,
  elements: z
    .array(z.strictObject({ value: z.string().max(2000), depth: z.number().int().min(0).max(64) }))
    .max(32),
});

/** Optional display reads never discard the native tree or bypass its final security scan. */
export async function supplementCalculatorDisplay(
  read: Awaited<ReturnType<ComputerDriver["readTree"]>>,
  window: WindowInfo,
  limits: Parameters<ComputerDriver["readTree"]>[1],
  worker: MacWorker,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<ComputerDriver["readTree"]>>> {
  // Existing text can be a label rather than the display; it cannot certify that
  // Calculator's value was returned. The fixed helper verifies the target app itself.
  const diagnose = (reason: "cancelled" | "worker_failed" | "worker_timeout" | "invalid_reply") => {
    const displayRead = { reason, visited: 0, found: 0, axStatus: 0 };
    limits.onDisplayRead?.(displayRead);
    return { ...read, displayRead };
  };
  let value: unknown;
  try {
    value = await worker.call(
      "staticText",
      {
        pid: window.pid,
        window: window.bounds,
        maxNodes: Math.min(limits.maxNodes, 2000),
        maxDepth: limits.maxDepth,
      },
      signal,
    );
  } catch (error) {
    if (signal?.aborted) {
      diagnose("cancelled");
      signal.throwIfAborted();
    }
    // Optional native read failures do not discard the original partial tree.
    if (
      error instanceof ComputerError &&
      (error.code === "driver_error" || error.code === "timeout")
    )
      return diagnose(error.code === "timeout" ? "worker_timeout" : "worker_failed");
    diagnose("worker_failed");
    throw error;
  }
  const parsed = StaticTextSchema.safeParse(value);
  if (!parsed.success) return diagnose("invalid_reply");
  const supplement = parsed.data;
  limits.onDisplayRead?.(supplement.diagnostic);
  signal?.throwIfAborted();
  const seen = new Set(read.elements.map((element) => element.value));
  let index = read.elements.reduce((max, element) => Math.max(max, element.index), 0);
  let added = 0;
  const displayElementIndexes: number[] = [];
  for (const element of supplement.elements) {
    if (read.elements.length >= limits.maxNodes) break;
    if (seen.has(element.value)) continue;
    seen.add(element.value);
    added++;
    // Read-only context, no native token: these values cannot target a UI action.
    read.elements.push({
      index: ++index,
      depth: element.depth,
      role: "AXStaticText",
      value: element.value,
      actions: [],
    });
    displayElementIndexes.push(index);
  }
  const displayRead: DisplayReadDiagnostic = {
    ...supplement.diagnostic,
    added,
    reason:
      supplement.elements.length && !added
        ? read.elements.length >= limits.maxNodes
          ? "output_limit"
          : "already_present"
        : supplement.diagnostic.reason,
  };
  limits.onDisplayRead?.(displayRead);
  return {
    ...read,
    requireFreshSecureScan: supplement.elements.length > 0,
    displayRead,
    displayElementIndexes,
  };
}
