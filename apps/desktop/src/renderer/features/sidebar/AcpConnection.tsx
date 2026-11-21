import { type MethodResults, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { type Peer, useRpc, useT } from "@pibot/renderer-kit";
import { Button, StatusDot } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "./sidebar.module.css";

type AcpState = MethodResults["acp.state"];
type Owner = { peer: Peer; abort: AbortController; revision: number; pending?: number };

export function AcpConnection() {
  const t = useT();
  const { peer, state } = useRpc();
  const current = useRef<Owner | undefined>(undefined);
  const [snapshot, setSnapshot] = useState<{ peer: Peer; value: AcpState }>();
  const [action, setAction] = useState<{
    owner: Owner;
    revision: number;
    busy?: boolean;
    error?: "workspace.acpDisconnectFailed" | "workspace.acpDisconnectUncertain";
  }>();
  useEffect(() => {
    setSnapshot(undefined);
    setAction(undefined);
    if (!peer || state !== "ready") return;
    const owner: Owner = { peer, abort: new AbortController(), revision: 0 };
    current.current = owner;
    const off = peer.on("acp.changed", (value) => {
      if (current.current !== owner || owner.abort.signal.aborted) return;
      owner.revision++;
      owner.pending = undefined;
      setSnapshot({ peer, value });
      setAction(undefined);
    });
    const revision = owner.revision;
    void peer.call("acp.state", {}, { signal: owner.abort.signal, timeoutMs: 10_000 }).then(
      (value) => {
        // The subscription may have already received a newer state than this initial read.
        if (!owner.abort.signal.aborted && revision === owner.revision)
          setSnapshot({ peer, value });
      },
      () => {
        // This is advisory display state; an unavailable read must not claim a connection.
      },
    );
    return () => {
      owner.abort.abort();
      off();
      if (current.current === owner) current.current = undefined;
    };
  }, [peer, state]);
  const value = state === "ready" && snapshot?.peer === peer ? snapshot.value : undefined;
  if (!value?.connected) return null;
  const owner = current.current;
  const visibleAction =
    owner && action?.owner === owner && action.revision === owner.revision ? action : undefined;
  const disconnect = () => {
    if (!owner || owner.peer !== peer || owner.abort.signal.aborted || owner.pending !== undefined)
      return;
    const revision = owner.revision;
    owner.pending = revision;
    setAction({ owner, revision, busy: true });
    const active = () =>
      current.current === owner && !owner.abort.signal.aborted && revision === owner.revision;
    void owner.peer
      .call("acp.disconnect", {}, { signal: owner.abort.signal, timeoutMs: 30_000 })
      .then(
        () => {
          if (active()) setSnapshot({ peer: owner.peer, value: { connected: false } });
        },
        (error: unknown) => {
          if (active())
            setAction({
              owner,
              revision,
              error:
                error instanceof RpcError && error.code === RpcErrorCodes.timeout
                  ? "workspace.acpDisconnectUncertain"
                  : "workspace.acpDisconnectFailed",
            });
        },
      )
      .finally(() => {
        if (active()) {
          owner.pending = undefined;
          setAction((previous) =>
            previous?.owner === owner && previous.revision === revision
              ? { ...previous, busy: false }
              : previous,
          );
        }
      });
  };
  const label = t("workspace.acpConnected", { name: value.client.name });
  return (
    <div className={styles.acpConnection}>
      <div className={styles.acpStatus}>
        <StatusDot state="done" />
        <span className={styles.statusText} title={label} role="status">
          {label}
        </span>
        <Button
          variant="ghost"
          className={styles.acpDisconnect}
          disabled={visibleAction?.busy}
          onClick={disconnect}
        >
          {t(visibleAction?.busy ? "workspace.acpDisconnecting" : "workspace.acpDisconnect")}
        </Button>
      </div>
      {visibleAction?.error && (
        <p className={styles.acpError} role="alert">
          {t(visibleAction.error)}
        </p>
      )}
    </div>
  );
}
