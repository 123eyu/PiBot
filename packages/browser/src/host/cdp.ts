import { RpcError, RpcErrorCodes } from "@pibot/browser-contract/full";
import type { WebContents } from "./platform.ts";

export type CdpListener = (params: Record<string, unknown>) => void;
export interface Cdp {
  htmlText?(html: string, options?: { maxElements?: number }): Promise<{ text: string }>;
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T>;
  on(method: string, listener: CdpListener): () => void;
  detach(): void;
}

/**
 * Attaches webContents.debugger. Commands sent before the first navigation never resolve and
 * captureScreenshot can hang during navigation, so the caller loads about:blank first and every
 * command here has a deadline.
 */
export function attachCdp(contents: WebContents, htmlText?: Cdp["htmlText"]): Cdp {
  const debug = contents.debugger;
  debug.attach("1.3");
  const listeners = new Map<string, Set<CdpListener>>();
  const receive = (_event: unknown, method: string, params: Record<string, unknown>) => {
    for (const listener of listeners.get(method) ?? []) {
      try {
        listener(params);
      } catch {
        // One subscriber must not break the debugger event stream for the others.
      }
    }
  };
  debug.on("message", receive);
  let attached = true;
  // The page closed its own window (or crashed): Electron detaches the debugger first.
  const detached = () => {
    attached = false;
  };
  debug.on("detach", detached);
  const gone = () => !attached || contents.isDestroyed();
  const closed = () => new RpcError(RpcErrorCodes.closed, "browser_tab_closed");
  let released = false;
  return {
    htmlText,
    send<T>(
      method: string,
      params?: Record<string, unknown>,
      timeoutMs = 10_000,
      signal?: AbortSignal,
    ) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (gone()) return Promise.reject(closed());
      return new Promise<T>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        };
        const abort = () => {
          cleanup();
          reject(signal?.reason);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new RpcError(RpcErrorCodes.timeout, "browser_timeout"));
        }, timeoutMs);
        signal?.addEventListener("abort", abort, { once: true });
        // Electron cannot cancel an in-flight debugger command; consume its late result.
        debug.sendCommand(method, params).then(
          (value) => {
            cleanup();
            resolve(value as T);
          },
          (error: unknown) => {
            cleanup();
            reject(gone() ? closed() : error);
          },
        );
      });
    },
    on(method, listener) {
      const set = listeners.get(method) ?? new Set();
      set.add(listener);
      listeners.set(method, set);
      return () => set.delete(listener);
    },
    detach() {
      if (released) return;
      released = true;
      attached = false;
      listeners.clear();
      debug.off("message", receive);
      debug.off("detach", detached);
      try {
        if (!contents.isDestroyed() && debug.isAttached()) debug.detach();
      } catch {
        // Already detached by a crashed renderer; nothing else holds the debugger.
      }
    },
  };
}
