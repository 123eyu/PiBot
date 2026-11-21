import { failureReasonKey } from "@pibot/i18n";
import type { ConnectionUse } from "@pibot/plugins-contract/full";
import type { Peer } from "@pibot/renderer-kit";
import { useRpcEvent, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useCallback, useState } from "react";
import { useConnectorsPorts } from "../shell/ports.tsx";
import { useConnectorPage } from "../shell/remote.ts";
import { ConnectorFeedback, ConnectorPagination } from "./ConnectorFeedback.tsx";
import styles from "./connectors.module.css";
import { connectionUseReasonKey } from "./use-reason-text.ts";

const PAGE = 10;

/** The connection's latest calls (audit and send drafts), each opening its receipt. */
export function ConnectorRecentUse({ id, snapshot }: { id: string; snapshot: number }) {
  const t = useT();
  const load = useCallback(
    (peer: Peer, signal: AbortSignal, cursor?: string) =>
      peer.call("connectors.recentUse", { id, before: cursor, limit: PAGE }, { signal }),
    [id],
  );
  const page = useConnectorPage(load, snapshot);
  // A call ends a run or settles an approval / draft; both change what this list shows.
  useRpcEvent("chat.done", page.refresh);
  useRpcEvent("approval.resolved", page.refresh);
  useRpcEvent("drafts.changed", page.refresh);
  return (
    <section className={styles.stack}>
      <h3>{t("connectors.recentUse")}</h3>
      <p className={styles.note}>{t("connectors.recentUseNote")}</p>
      <ConnectorFeedback loading={page.loading} error={page.error} retry={page.refresh} />
      {page.value?.items.map((use) => (
        <UseRow key={use.id} use={use} />
      ))}
      {page.value && !page.value.items.length && (
        <p className={styles.note}>{t("connectors.noRecentUse")}</p>
      )}
      <ConnectorPagination previous={page.previous} next={page.next} disabled={page.loading} />
    </section>
  );
}

function UseRow({ use }: { use: ConnectionUse }) {
  const t = useT();
  const { RunReceipt } = useConnectorsPorts();
  const [open, setOpen] = useState(false);
  const who = use.groupId
    ? (use.groupName ?? t("connectors.unavailableGroup"))
    : (use.botName ?? t("connectors.unavailableBot"));
  const receipt = RunReceipt && use.runId ? { Receipt: RunReceipt, runId: use.runId } : undefined;
  const reasonKey = use.reasonCode
    ? (connectionUseReasonKey(use.reasonCode) ?? failureReasonKey(use.reasonCode))
    : undefined;
  // A code with no text yet still says what happened; the code is only a last-resort detail.
  const result = !use.reasonCode
    ? t(`connectors.use.${use.outcome}`)
    : reasonKey
      ? `${t(`connectors.use.${use.outcome}`)} · ${t(reasonKey)}`
      : t(use.outcome === "denied" ? "connectors.use.deniedCode" : "connectors.use.failedCode", {
          code: use.reasonCode,
        });
  return (
    <div className={styles.stack}>
      <div className={styles.row}>
        <span className={styles.grow}>
          {new Date(use.at).toLocaleString()} · {who} ·{" "}
          {use.tool ?? t("connectors.use.unknownTool")} · {t(`connectors.use.${use.kind}`)}
        </span>
        <span className={use.outcome === "failed" ? styles.warn : styles.note}>{result}</span>
        {receipt && (
          <Button variant="ghost" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {t(open ? "connectors.use.hideReceipt" : "connectors.use.receipt")}
          </Button>
        )}
      </div>
      {receipt && open && <receipt.Receipt runId={receipt.runId} />}
    </div>
  );
}
