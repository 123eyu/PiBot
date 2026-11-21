import type {
  BringOverResult,
  DiscoveredItem,
  DiscoveredItemKind,
  DiscoveryResult,
} from "@pibot/plugins-contract/full";
import { useRpc } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";
import { connectorError } from "../../shell/remote.ts";

export type DiscoveredRow = DiscoveredItem & { sourceId: string; sourceName: string };

/**
 * Reads what other AI tools have. Opening the page asks the brain, which reads nothing until the
 * person has agreed once; after that each opening looks again. Results carry names
 * and opaque keys only.
 */
export function useDiscovery(changed: () => void) {
  const { peer } = useRpc();
  const [result, setResult] = useState<DiscoveryResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ReturnType<typeof connectorError>>();
  const [busy, setBusy] = useState(false);
  const owner = useRef<AbortController | undefined>(undefined);
  const load = useCallback(async (): Promise<DiscoveryResult | undefined> => {
    if (!peer) return undefined;
    owner.current?.abort();
    const controller = new AbortController();
    owner.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const value = await peer.call(
        "connections.discover",
        {},
        { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) },
      );
      if (controller.signal.aborted) return undefined;
      setResult(value);
      return value;
    } catch (failure) {
      if (!controller.signal.aborted) setError(connectorError(failure));
      return undefined;
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [peer]);
  useEffect(() => {
    void load();
    return () => owner.current?.abort();
  }, [load]);
  /** Resolves to the first look after agreeing, so the caller can go straight on to it. */
  const consent = useCallback(
    async (allow: boolean): Promise<DiscoveryResult | undefined> => {
      if (!peer) return undefined;
      setBusy(true);
      // Withdrawing also drops the look in flight: its answer must not reappear afterwards.
      if (!allow) {
        owner.current?.abort();
        setLoading(false);
      }
      try {
        await peer.call("connections.discoverConsent", { allow });
        if (allow) return await load();
        setResult({ scannedAt: null, consent: false, sources: [] });
        return undefined;
      } catch (failure) {
        setError(connectorError(failure));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [peer, load],
  );
  const bringOver = useCallback(
    async (
      keys: string[],
      signal?: AbortSignal,
      batchId?: string,
    ): Promise<BringOverResult[] | undefined> => {
      if (!peer || !keys.length) return undefined;
      setBusy(true);
      setError(undefined);
      try {
        const value = await peer.call(
          "connections.bringOver",
          { keys, ...(batchId ? { batchId } : {}) },
          { timeoutMs: 600_000, ...(signal ? { signal } : {}) },
        );
        return value.results;
      } catch (failure) {
        // A stop request rejects here as soon as the frame is sent, which says nothing about the
        // brain having stopped: the dialog waits for its own receipt and closes from there.
        if (!signal?.aborted) setError(connectorError(failure));
        return undefined;
      } finally {
        setBusy(false);
        changed();
        // A stopped batch may still have imported some items, so the list refreshes either way.
        if (!signal?.aborted) void load();
      }
    },
    [peer, load, changed],
  );
  const rows = (kind?: DiscoveredItemKind): DiscoveredRow[] =>
    (result?.sources ?? []).flatMap((source) =>
      source.items
        .filter((item) => !kind || item.kind === kind)
        .map((item) => ({ ...item, sourceId: source.id, sourceName: source.name })),
    );
  return { result, loading, error, busy, load, consent, bringOver, rows };
}

/** Short marks for the tool chips (design: CC, CX, pi…); names are not brand artwork. */
export const sourceMark: Record<string, string> = {
  "claude-code": "CC",
  codex: "CX",
  cursor: "CU",
  pi: "pi",
  opencode: "OC",
};

/**
 * What a tab offers to bring over (maintainers 2026-10-31): the MCP tab only MCP servers, the 技能 tab
 * only skills; a plugin package shows in each tab whose kind of content it carries.
 */
export function offeredIn(row: DiscoveredItem, tab: "mcp" | "skills") {
  if (row.kind === "plugin") return tab === "mcp" ? !!row.contains?.mcp : !!row.contains?.skills;
  return row.kind === (tab === "mcp" ? "mcp" : "skill");
}
