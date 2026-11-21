import type { ExternalAgentId } from "@pibot/external-agents-contract";
import { Overlay, useRpc, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useState } from "react";
import styles from "./agents.module.css";
import { errorKey } from "./shared.tsx";

/** Decision 5 (external-agents.html `win-confirm`): one agent, unisolated, on Windows. */
export function ConfirmUnisolatedDialog({
  agentId,
  botId,
  name,
  onClose,
  onConfirmed,
}: {
  agentId: ExternalAgentId;
  /** A custom command's Bot: the confirmation covers that exact command only. */
  botId?: string;
  name: string;
  onClose(): void;
  onConfirmed(): void;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const confirm = async () => {
    if (!peer) return;
    setBusy(true);
    try {
      await peer.call("externalAgents.confirmUnisolated", {
        agentId,
        ...(botId ? { botId } : {}),
        confirmed: true,
      });
      onConfirmed();
    } catch (error) {
      setFailure(t(errorKey(error)));
      setBusy(false);
    }
  };
  return (
    <Overlay
      title={t("externalAgents.windows.title", { name })}
      icon="warning"
      tone="amber"
      busy={busy}
      close={onClose}
      footer={
        <div className={styles.footer}>
          <span />
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button loading={busy} onClick={() => void confirm()}>
            {t("externalAgents.create.confirmWindows")}
          </Button>
        </div>
      }
    >
      <div className={styles.stack}>
        <p className={styles.note}>{t("externalAgents.windows.body", { name })}</p>
        <p className={styles.band} data-tone="warn">
          <Icon name="warning" size={16} />
          {t("externalAgents.windows.advice")}
        </p>
        {failure && (
          <p role="alert" className={styles.error}>
            {failure}
          </p>
        )}
      </div>
    </Overlay>
  );
}
