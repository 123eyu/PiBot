import type { ComputerState, ComputerStep } from "@pibot/computer-use-contract/full";
import { type Peer, useRpc } from "@pibot/renderer-kit";
import { useEffect, useMemo, useSyncExternalStore } from "react";

const emptyStates: ReadonlyMap<string, ComputerState> = new Map();
const noopSubscribe = () => () => {};

/**
 * One `computer.status` read and one `computer.state` listener per peer, shared by every
 * sidebar row and chat message; the listener is released when the last subscriber leaves.
 */
class ComputerStateStore {
  private states: ReadonlyMap<string, ComputerState> = emptyStates;
  private listeners = new Set<() => void>();
  private off?: () => void;
  private epoch = 0;
  constructor(private readonly peer: Peer) {}
  snapshot = () => this.states;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };
  private set(next: ReadonlyMap<string, ComputerState>) {
    this.states = next;
    for (const listener of this.listeners) listener();
  }
  private start() {
    const epoch = ++this.epoch;
    let live = false;
    this.off = this.peer.on("computer.state", (state) => {
      live = true;
      const next = new Map(this.states);
      if (state.state === "idle") next.delete(state.botId);
      else next.set(state.botId, state);
      this.set(next);
    });
    void this.peer
      .call("computer.status", undefined)
      .then((states) => {
        // Live events are newer than a snapshot that was requested before them.
        if (epoch !== this.epoch || live) return;
        this.set(new Map(states.filter((s) => s.state !== "idle").map((s) => [s.botId, s])));
      })
      .catch(() => {
        // Advisory only (sidebar text); state events still arrive once brain handles them.
      });
  }
  private stop() {
    this.epoch++;
    this.off?.();
    this.off = undefined;
    this.states = emptyStates;
  }
}

const stores = new WeakMap<Peer, ComputerStateStore>();
const emptyStatesSnapshot = () => emptyStates;
export function useComputerStates(): ReadonlyMap<string, ComputerState> {
  const { peer } = useRpc();
  const store = useMemo(() => {
    if (!peer) return undefined;
    let found = stores.get(peer);
    if (!found) {
      found = new ComputerStateStore(peer);
      stores.set(peer, found);
    }
    return found;
  }, [peer]);
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.snapshot ?? emptyStatesSnapshot,
    store?.snapshot ?? emptyStatesSnapshot,
  );
}

export interface RunStepsState {
  byToolCall: ReadonlyMap<string, ComputerStep[]>;
  error: boolean;
  retry?: () => void;
}
const emptyRun: RunStepsState = { byToolCall: new Map(), error: false };
const emptyRunSnapshot = () => emptyRun;
const MAX_PAGES = 5;

/** Steps for one run: one paged read plus live `computer.step` events, grouped by tool call. */
class RunSteps {
  private steps = new Map<string, ComputerStep>();
  private state: RunStepsState = emptyRun;
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private active = false;
  private reading?: AbortController;
  constructor(
    private readonly peer: Peer,
    private readonly runId: string,
  ) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  start() {
    this.active = true;
    const off = this.peer.on("computer.step", ({ step }) => {
      if (step.runId !== this.runId) return;
      this.steps.set(step.id, step);
      // Bursts of steps are merged into one render (step events are throttled).
      this.timer ??= setTimeout(() => this.publish(this.state.error), 150);
    });
    void this.load();
    return () => {
      this.active = false;
      off();
      clearTimeout(this.timer);
      this.timer = undefined;
      this.reading?.abort();
    };
  }
  private load = async () => {
    this.reading?.abort();
    const reading = new AbortController();
    this.reading = reading;
    try {
      let before: string | undefined;
      // Bounded: a run cannot hold more steps than tool calls, and 1000 is far past real runs.
      for (let page = 0; page < MAX_PAGES; page++) {
        const items = await this.peer.call("computer.steps", {
          runId: this.runId,
          limit: 200,
          ...(before ? { before } : {}),
        });
        if (reading.signal.aborted || !this.active) return;
        for (const step of items) if (!this.steps.has(step.id)) this.steps.set(step.id, step);
        if (items.length < 200) break;
        before = items.at(-1)?.id;
      }
      this.publish(false);
    } catch {
      if (!reading.signal.aborted && this.active) this.publish(true);
    }
  };
  private publish(error: boolean) {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.active) return;
    const byToolCall = new Map<string, ComputerStep[]>();
    const ordered = [...this.steps.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const step of ordered) {
      const list = byToolCall.get(step.toolCallId);
      if (list) list.push(step);
      else byToolCall.set(step.toolCallId, [step]);
    }
    this.state = { byToolCall, error, retry: error ? () => void this.load() : undefined };
    for (const listener of this.listeners) listener();
  }
}

export function useRunSteps(runId: string, enabled: boolean): RunStepsState {
  const { peer } = useRpc();
  const store = useMemo(
    () => (peer && enabled ? new RunSteps(peer, runId) : undefined),
    [peer, runId, enabled],
  );
  useEffect(() => store?.start(), [store]);
  return useSyncExternalStore(
    store?.subscribe ?? noopSubscribe,
    store?.snapshot ?? emptyRunSnapshot,
    store?.snapshot ?? emptyRunSnapshot,
  );
}
