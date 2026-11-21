import type { createOfficeRenderHost } from "../host/office-render.ts";

type Host = ReturnType<typeof createOfficeRenderHost>;

/** Keep the converter graph off startup; one owner still controls its window and IPC cleanup. */
export function lazyOfficeRender(
  options: Parameters<typeof createOfficeRenderHost>[0],
  report: (durationMs: number) => void,
): Host {
  let pending: Promise<Host> | undefined;
  const lifetime = new AbortController();
  return {
    async render(params, parent) {
      const signal = AbortSignal.any([parent, lifetime.signal]);
      signal.throwIfAborted();
      pending ??= (async () => {
        const at = performance.now();
        const { createOfficeRenderHost } = await import("../host/office-render.ts");
        lifetime.signal.throwIfAborted();
        report(Math.round(performance.now() - at));
        return createOfficeRenderHost(options);
      })();
      const host = await pending;
      signal.throwIfAborted();
      return host.render(params, signal);
    },
    async dispose() {
      lifetime.abort();
      // A late import must not create a converter after its host has stopped.
      const loaded = await Promise.allSettled(pending ? [pending] : []);
      const value = loaded[0];
      if (value?.status === "fulfilled") await value.value.dispose();
    },
  };
}
