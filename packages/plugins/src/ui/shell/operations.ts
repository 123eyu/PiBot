import type { ConnectorOperation } from "@pibot/plugins-contract/full";
import { useRpc, useRpcEvent } from "@pibot/renderer-kit";
import { useCallback, useEffect, useRef, useState } from "react";

export interface OperationRow {
  id: string;
  installationId: string;
  connectorId: string | null;
  operation?: ConnectorOperation;
  attempts: number;
  unknown?: boolean;
}
export function operationPending(row: OperationRow) {
  return (
    !row.unknown &&
    (!row.operation || ["pending", "running", "stopping"].includes(row.operation.state))
  );
}

export function useConnectorOperations(changed: () => void) {
  const { peer } = useRpc();
  const [rows, setRows] = useState<OperationRow[]>([]);
  const current = useRef(rows);
  current.current = rows;
  const merge = useCallback((operation: ConnectorOperation) => {
    setRows((previous) => {
      const existing = previous.find((row) => row.id === operation.id);
      if (existing?.operation && existing.operation.revision >= operation.revision) return previous;
      const next: OperationRow = {
        id: operation.id,
        installationId: operation.installationId,
        connectorId: operation.connectorId,
        operation,
        attempts: 0,
      };
      return [...previous.filter((row) => row.id !== operation.id), next].slice(-60);
    });
  }, []);
  useRpcEvent("connectors.operationChanged", (operation) => {
    merge(operation);
    changed();
  });
  const track = (id: string, installationId: string, connectorId: string | null) => {
    // The terminal event can precede the RPC ACK: never replace it with a pending placeholder.
    setRows((previous) =>
      previous.some((row) => row.id === id)
        ? previous
        : [...previous, { id, installationId, connectorId, attempts: 0 }].slice(-60),
    );
  };
  const [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Manual recovery restarts the bounded polling window immediately.
  useEffect(() => {
    if (!peer) return;
    const owner = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const waiting = current.current.filter((row) => operationPending(row) && !row.unknown);
      for (const row of waiting) {
        if (owner.signal.aborted) return;
        try {
          const operation = await peer.call(
            "connectors.operation",
            { operationId: row.id },
            { signal: owner.signal, timeoutMs: 5_000 },
          );
          if (owner.signal.aborted) return;
          merge(operation);
          if (!["pending", "running", "stopping"].includes(operation.state)) changed();
        } catch {
          // An unavailable snapshot is not a failed remote operation. Keep it explicitly uncertain.
        }
        if (owner.signal.aborted) return;
        setRows((previous) =>
          previous.map((value) =>
            value.id === row.id && operationPending(value)
              ? { ...value, attempts: value.attempts + 1, unknown: value.attempts >= 14 }
              : value,
          ),
        );
      }
      if (!owner.signal.aborted) timer = setTimeout(() => void poll(), 2_000);
    };
    void poll();
    return () => {
      owner.abort();
      clearTimeout(timer);
    };
  }, [peer, merge, changed, retry]);
  const check = () => {
    setRows((previous) => previous.map((row) => ({ ...row, attempts: 0, unknown: false })));
    setRetry((v) => v + 1);
    changed();
  };
  return { rows, track, check };
}
