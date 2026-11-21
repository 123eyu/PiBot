import { useEffect, useState } from "react";
import type { Peer } from "../../rpc/context.ts";

/** A paired, unrevoked runner as the folder choosers show it. */
export interface RunnerEntry {
  /** The execution location (`runner:<id>`) a folder on it is registered with. */
  id: string;
  name: string;
  online: boolean;
}

/**
 * The paired runners every folder chooser offers, kept current with `devices.changed`.
 * A failed read shows no runners rather than stale ones.
 */
export function useRunners(peer: Pick<Peer, "call" | "on"> | null): RunnerEntry[] {
  const [runners, setRunners] = useState<RunnerEntry[]>([]);
  useEffect(() => {
    if (!peer) return;
    const lifetime = new AbortController();
    let reading: AbortController | undefined;
    setRunners([]);
    const load = async () => {
      reading?.abort();
      const controller = new AbortController();
      reading = controller;
      const signal = AbortSignal.any([
        lifetime.signal,
        controller.signal,
        AbortSignal.timeout(10_000),
      ]);
      try {
        const page = await peer.call("devices.list", { limit: 100 }, { signal });
        signal.throwIfAborted();
        setRunners(
          page.items.flatMap((device) =>
            device.kind === "runner" && device.target && !device.revokedAt
              ? [{ id: device.target, name: device.name, online: device.online }]
              : [],
          ),
        );
      } catch {
        if (!lifetime.signal.aborted && !controller.signal.aborted) setRunners([]);
      }
    };
    void load();
    const off = peer.on("devices.changed", () => void load());
    return () => {
      lifetime.abort();
      reading?.abort();
      off();
    };
  }, [peer]);
  return runners;
}

/** Where a runner folder picked in the browser goes in the conversation's selection. */
export type RunnerPickTarget = "primary" | "readonly" | "only";
