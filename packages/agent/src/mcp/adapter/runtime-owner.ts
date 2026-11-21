// Derived from nicobailon/pi-mcp-adapter@5.3.1 (commit efe943e637e503e10af382d0ace1aec834989c69), MIT.
// Copyright (c) 2026 Nico Bailon. Full license: packages/agent/src/mcp/adapter/LICENSE.
// Modified by Pi Bot: reduced to combineAbortSignals; host lifecycle callbacks and raw console error output removed.
// Upstream file: runtime-owner.ts
// Cut: createMcpRuntimeOwner and isAbortError — the pi runtime owner (and its
// console.error reporting of raw cleanup errors) has no Pi Bot caller; the
// brain pool owns lifetimes and reports through structured logging.

export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(active);

  // AbortSignal.any was added after Node 20.0.0, our minimum supported version.
  const controller = new AbortController();
  const alreadyAborted = active.find((signal) => signal.aborted);
  if (alreadyAborted) {
    controller.abort(alreadyAborted.reason);
    return controller.signal;
  }

  const onAbort = (event: Event) => {
    for (const signal of active) signal.removeEventListener("abort", onAbort);
    controller.abort((event.target as AbortSignal).reason);
  };
  for (const signal of active) signal.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}
