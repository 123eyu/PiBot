import type { ConnectionTarget, ConnectorAccess } from "@pibot/plugins-contract/full";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useState } from "react";
import { ConnectorAccessEditor } from "./ConnectorAccessEditor.tsx";
import styles from "./connectors.module.css";

/** A reason-strip shortcut proposes a scope; only the confirmation button persists it. */
export function ConnectionAccessProposal({
  access,
  target,
  disabled,
  confirm,
}: {
  access: ConnectorAccess;
  target: ConnectionTarget;
  disabled: boolean;
  confirm(access: ConnectorAccess): void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<ConnectorAccess>(() => ({
    mode: "selected",
    bots: target.kind === "bot" ? [...new Set([...access.bots, target.id])] : access.bots,
    groups: target.kind === "group" ? [...new Set([...access.groups, target.id])] : access.groups,
  }));
  return (
    <section className={styles.stack}>
      <p className={styles.note}>{t("connectors.allowTargetNote")}</p>
      <ConnectorAccessEditor
        access={draft}
        requestedTarget={target}
        disabled={disabled}
        save={setDraft}
      />
      <div className={styles.row}>
        <Button variant="secondary" disabled={disabled} onClick={() => confirm(draft)}>
          {t("connectors.allowTarget")}
        </Button>
      </div>
    </section>
  );
}
