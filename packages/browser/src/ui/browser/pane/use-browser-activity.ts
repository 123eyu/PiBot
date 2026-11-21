import type { BrowserState } from "@pibot/browser-contract/full";
import { type Peer, useRpc, useRpcEvent } from "@pibot/renderer-kit";
import { useCallback, useEffect, useState } from "react";

/** While the Bot is answering, re-read now and then in case a browser event was missed. */
const RUNNING_POLL_MS = 4000;

export interface BrowserActivity {
  state: BrowserState | null;
  /** Pages open, taken over or recording: show the side pane / "browser in use". */
  active: boolean;
  /** Pages asleep with tabs to restore; keeps the pane and pill, never opens the pane. */
  sleeping: boolean;
  refresh(): void;
  /** Adopt a state an RPC just returned (it also arrives as an event, possibly later). */
  apply(state: BrowserState): void;
}

/**
 * Whether a Bot's browser is in use, from `browser.tabs` once plus `browser.state` events.
 * T13's side pane uses `active` to appear on its own and the chat title bar to show
 * "browser in use" when the pane is closed. `running` (the Bot is answering) adds a slow poll.
 */
export function useBrowserActivity(
  botId: string | undefined,
  options: { running?: boolean; peer?: Peer | null; groupId?: string } = {},
): BrowserActivity {
  const rpc = useRpc();
  const groupId = options.groupId;
  const peer = options.peer === undefined ? rpc.peer : options.peer;
  const [state, setState] = useState<BrowserState | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useRpcEvent("browser.state", (next) => {
    if (next.botId === botId && next.groupId === groupId) setState(next);
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: the revision counter re-reads on demand
  useEffect(() => {
    // A different Bot or a new brain connection starts from a fresh read.
    setState((previous) =>
      previous && previous.botId === botId && previous.groupId === groupId ? previous : null,
    );
    if (!peer || !botId) return;
    const controller = new AbortController();
    void peer
      .call(
        "browser.tabs",
        { botId, ...(groupId ? { groupId } : {}) },
        { signal: controller.signal },
      )
      .then((next) => {
        if (!controller.signal.aborted && next.botId === botId && next.groupId === groupId)
          setState(next);
      })
      .catch(() => {
        // No browser host (e.g. brain still starting) reads as "not in use"; events still apply.
      });
    return () => controller.abort();
  }, [peer, botId, groupId, revision]);

  const running = options.running === true;
  useEffect(() => {
    if (!running || !peer || !botId) return;
    const timer = setInterval(refresh, RUNNING_POLL_MS);
    return () => clearInterval(timer);
  }, [running, peer, botId, refresh]);

  const apply = useCallback(
    (next: BrowserState) => {
      if (next.botId === botId && next.groupId === groupId) setState(next);
    },
    [botId, groupId],
  );
  const current = state && state.botId === botId && state.groupId === groupId ? state : null;
  return {
    state: current,
    active:
      !!current &&
      (current.open || current.takeover || current.recording || current.tabs.length > 0),
    sleeping: !!current?.sleeping,
    refresh,
    apply,
  };
}
