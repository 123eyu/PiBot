import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { Peer } from "@pibot/renderer-kit";
import { useEffect, useState } from "react";
import { logRpc } from "./use-log.ts";
export function useHistoryOutput(
  peer: Peer | null,
  runId: string,
  toolCallId: string | undefined,
  enabled: boolean,
) {
  const [state, setState] = useState<{
    text: string;
    loading: boolean;
    error?: "missing" | "failed";
  }>({ text: "", loading: false });
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry reads the same run again.
  useEffect(() => {
    if (!enabled) return;
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(25_000)]);
    setState({ text: "", loading: true });
    if (peer)
      void logRpc(
        () =>
          peer.call(
            "runs.readLog",
            { runId, ...(toolCallId ? { toolCallId } : {}), limit: 32_768 },
            { timeoutMs: 22_000 },
          ),
        signal,
      )
        .then((page) => {
          if (!lifetime.signal.aborted)
            setState({
              text: page.text.slice(-40_000).split("\n").slice(0, 200).join("\n"),
              loading: false,
            });
        })
        .catch((error) => {
          if (!lifetime.signal.aborted)
            setState({
              text: "",
              loading: false,
              error:
                error instanceof RpcError && error.code === RpcErrorCodes.runLogMissing
                  ? "missing"
                  : "failed",
            });
        });
    else setState({ text: "", loading: false, error: "failed" });
    return () => lifetime.abort();
  }, [peer, runId, toolCallId, enabled, revision]);
  return {
    ...(enabled ? state : { text: "", loading: false }),
    retry: () => setRevision((value) => value + 1),
  };
}
