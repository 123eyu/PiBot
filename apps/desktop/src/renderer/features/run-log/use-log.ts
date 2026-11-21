import { type MethodResults, RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { Peer } from "@pibot/renderer-kit";
import { useEffect, useMemo, useSyncExternalStore } from "react";

type Page = MethodResults["runs.readLog"];
export async function logRpc<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      action().then(resolve, reject);
    });
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
interface State {
  text: string;
  loading: boolean;
  error?: "missing" | "failed";
  next: number | null;
  truncated: boolean;
  started: boolean;
}
class LogReader {
  private lifetime = new AbortController();
  private listeners = new Set<() => void>();
  private pending?: Promise<string>;
  private state: State = { text: "", loading: false, next: 0, truncated: false, started: false };
  constructor(
    private readonly peer: Peer | null,
    private readonly runId: string,
    private readonly toolCallId?: string,
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<State>) {
    if (this.lifetime.signal.aborted) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  start() {
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    void this.load().catch(() => {
      /* Read failures are already published for retry. */
    });
    return () => {
      this.lifetime.abort();
      this.pending = undefined;
    };
  }
  load = (): Promise<string> => {
    if (this.pending) return this.pending;
    if (this.state.next === null) return Promise.resolve(this.state.text);
    this.publish({ loading: true, error: undefined });
    const pending = this.read().finally(() => {
      if (this.pending === pending) {
        this.pending = undefined;
        this.publish({ loading: false });
      }
    });
    this.pending = pending;
    return pending;
  };
  private async read() {
    const lifetime = this.lifetime;
    try {
      const peer = this.peer;
      if (!peer) throw new Error("brain_unavailable");
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(25_000)]);
      const offset = this.state.next ?? 0;
      const page: Page = await logRpc(
        () =>
          peer.call(
            "runs.readLog",
            {
              runId: this.runId,
              ...(this.toolCallId ? { toolCallId: this.toolCallId } : {}),
              offset,
            },
            { timeoutMs: 22_000 },
          ),
        signal,
      );
      signal.throwIfAborted();
      if (page.offset !== offset || (page.nextOffset !== null && page.nextOffset <= offset))
        throw new Error("log_cursor_invalid");
      const text = this.state.text + page.text;
      this.publish({ text, next: page.nextOffset, truncated: page.truncated, started: true });
      return text;
    } catch (error) {
      if (!lifetime.signal.aborted)
        this.publish({
          error:
            error instanceof RpcError && error.code === RpcErrorCodes.runLogMissing
              ? "missing"
              : "failed",
        });
      throw error;
    }
  }
  all = async (parent?: AbortSignal) => {
    const signal = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(120_000),
      ...(parent ? [parent] : []),
    ]);
    try {
      do {
        await logRpc(() => this.load(), signal);
      } while (this.state.next !== null);
      return this.state.text;
    } catch (error) {
      if (signal.reason instanceof Error && signal.reason.name === "TimeoutError")
        this.publish({ error: "failed" });
      throw error;
    }
  };
}
export function useLog(peer: Peer | null, runId: string, toolCallId?: string) {
  const reader = useMemo(() => new LogReader(peer, runId, toolCallId), [peer, runId, toolCallId]);
  useEffect(() => reader.start(), [reader]);
  const state = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot);
  return { ...state, load: reader.load, all: reader.all };
}
