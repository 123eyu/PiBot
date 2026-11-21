import type { ConnectorAccess } from "@pibot/plugins-contract/full";
import { type Peer, useRpcEvent, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useCallback, useState } from "react";
import { useConnectorAction, useConnectorRead } from "../shell/remote.ts";
import { ConnectorAccessEditor } from "./ConnectorAccessEditor.tsx";
import { ConnectorFeedback } from "./ConnectorFeedback.tsx";
import styles from "./connectors.module.css";

export function ImportedSkillAssignment({
  installationId,
  changed,
}: {
  installationId: string;
  changed(): void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<ConnectorAccess>({
    mode: "selected",
    bots: [],
    groups: [],
  });
  const status = useConnectorRead(
    useCallback(
      (peer: Peer, signal: AbortSignal) =>
        peer.call("plugins.skillAssignments", { installationId }, { signal }),
      [installationId],
    ),
  );
  useRpcEvent("plugins.changed", (event) => {
    if (event.installationId === installationId) status.refresh();
  });
  const action = useConnectorAction(() => {
    status.refresh();
    changed();
  });
  // A missing/error snapshot is not proof that the installation has no remaining skills.
  if (status.loading || status.error || !status.value)
    return (
      <section className={styles.card}>
        <ConnectorFeedback loading={status.loading} error={status.error} retry={status.refresh} />
      </section>
    );
  if (!status.value.unassignedCount && !status.value.pendingTargetCount) return null;
  const revision = status.value.revision;
  return (
    <section className={styles.card}>
      {!!status.value.pendingTargetCount && (
        <p className={styles.note}>{t("connectors.skillsPartial")}</p>
      )}
      <p>{t("connectors.unassignedSkills", { count: status.value.unassignedCount })}</p>
      {!open ? (
        <Button variant="secondary" onClick={() => setOpen(true)}>
          {t("connectors.assignSkills")}
        </Button>
      ) : (
        <>
          <ConnectorAccessEditor access={targets} disabled={action.disabled} save={setTargets} />
          <Button
            disabled={action.disabled || (!targets.bots.length && !targets.groups.length)}
            onClick={() =>
              void action.run((peer, signal) =>
                peer.call(
                  "plugins.assignSkills",
                  {
                    installationId,
                    expectedRevision: revision,
                    targets: { bots: targets.bots, groups: targets.groups },
                  },
                  { signal, timeoutMs: 30_000 },
                ),
              )
            }
          >
            {t("connectors.assignSkills")}
          </Button>
          <ConnectorFeedback loading={false} error={action.error} retry={status.refresh} />
        </>
      )}
    </section>
  );
}
