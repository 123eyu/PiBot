import type { ChatNotice, ConnectionAvailability, ConnectionTarget } from "@pibot/protocol";
import { connectionNeedsUser } from "@pibot/protocol";
import { useNavigation, useRpc, useRpcEvent, useSettings } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useEffect, useState } from "react";
import styles from "../../autocheck/auto-check.module.css";

function neededReason(
  value: ConnectionAvailability,
  target: ConnectionTarget,
):
  | "not_connected"
  | "needs_auth"
  | "error"
  | "disabled"
  | "no_access_bot"
  | "no_access_group"
  | "tool_disabled"
  | "read_only_mode"
  | undefined {
  switch (value.reason) {
    case "no_access":
      return target.kind === "group" ? "no_access_group" : "no_access_bot";
    case "not_connected":
    case "needs_auth":
    case "error":
    case "disabled":
    case "tool_disabled":
    case "read_only_mode":
      return value.reason;
    default:
      return undefined;
  }
}

export function ConnectionNeeded({
  notice,
}: {
  notice: Extract<ChatNotice, { kind: "connection_needed" }>;
}) {
  const { t, language } = useSettings();
  const navigation = useNavigation();
  const { peer } = useRpc();
  const [fresh, setFresh] = useState<{
    id: string;
    peer: typeof peer;
    value: ConnectionAvailability;
  }>();
  const [revision, setRevision] = useState(0);
  useRpcEvent("connectors.changed", () => setRevision((value) => value + 1));
  useRpcEvent("plugins.changed", () => setRevision((value) => value + 1));
  const { target } = notice;
  const connection = notice.availability.connectorId ?? notice.availability.connection;
  // biome-ignore lint/correctness/useExhaustiveDependencies: connector/plugin events invalidate the bounded read.
  useEffect(() => {
    const abort = new AbortController();
    if (peer && connection !== "unknown") {
      void peer
        .call(
          "connections.availability",
          { target: { kind: target.kind, id: target.id }, connection },
          { signal: abort.signal, timeoutMs: 10_000 },
        )
        .then((value) => {
          if (!abort.signal.aborted) setFresh({ id: notice.id, peer, value });
        })
        .catch(() => {
          /* Keep the original diagnostic when current status is unavailable. */
        });
    }
    return () => abort.abort();
  }, [peer, connection, target.kind, target.id, notice.id, revision]);
  const value = fresh?.id === notice.id && fresh.peer === peer ? fresh.value : notice.availability;
  // Older records include lookups of names that do not exist; a fixed connection disappears.
  const reason = connectionNeedsUser(value) ? neededReason(value, target) : undefined;
  if (!reason) return null;
  const action =
    value.reason === "needs_auth"
      ? "reauthorize"
      : value.reason === "not_connected" || value.reason === "error"
        ? "connect"
        : "settings";
  const name = value.name[language];
  return (
    <section className={styles.card} aria-label={t(`connectors.reason.${reason}`, { name })}>
      <div className={styles.cardHead}>
        <Icon name="link" size={16} />
        <span>{t(`connectors.reason.${reason}`, { name })}</span>
      </div>
      <p className={styles.cardSub}>{t(`connectors.needed.do.${reason}`, { name })}</p>
      <div className={styles.actions}>
        <Button
          variant="primary"
          onClick={() => {
            navigation.openPage("connectors");
            navigation.navigate({
              name: "connectors",
              connection: {
                id: value.connection,
                connectorId: value.connectorId,
                target,
                section:
                  value.reason === "no_access"
                    ? "access"
                    : action === "settings"
                      ? "advanced"
                      : undefined,
              },
            });
          }}
        >
          {t(`connectors.action.${action}`)}
        </Button>
      </div>
    </section>
  );
}
