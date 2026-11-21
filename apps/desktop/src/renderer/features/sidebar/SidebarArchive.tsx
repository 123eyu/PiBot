import { useRpc, useT, useWorkspace } from "@pibot/renderer-kit";
import { Icon, IconTile } from "@pibot/ui";
import { useState } from "react";
import { AppDialog } from "../app-menu/AppDialog.tsx";
import { ArchivedBots } from "../app-menu/ArchivedBots.tsx";
import { ArchivedGroups } from "../workspace/new-chat/ArchivedGroups.tsx";
import styles from "./sidebar.module.css";

export function SidebarArchive() {
  const t = useT();
  const { archivedCount = 0 } = useWorkspace();
  const { peer } = useRpc();
  const [openedPeer, setOpenedPeer] = useState<typeof peer>();
  const open = !!peer && openedPeer === peer;
  const close = () => setOpenedPeer(undefined);
  return (
    <>
      {archivedCount > 0 && (
        <button
          type="button"
          className={`${styles.bot} ${styles.archive}`}
          data-sidebar-archive
          aria-haspopup="dialog"
          disabled={!peer}
          onClick={() => setOpenedPeer(peer)}
        >
          <IconTile icon="box" tone="neutral" size="sm" />
          <span className={styles.archiveLabel}>
            {t("workspace.archivedCount", { count: archivedCount })}
          </span>
          <Icon name="chevronRight" size={13} />
        </button>
      )}
      {open && (
        <AppDialog title={t("workspace.archived")} close={close}>
          <section className={styles.archiveSection} data-tone="violet">
            <h2>{t("workspace.archivedBots")}</h2>
            <ArchivedBots close={close} />
          </section>
          <section className={styles.archiveSection} data-tone="teal">
            <h2>{t("group.archived")}</h2>
            <ArchivedGroups />
          </section>
        </AppDialog>
      )}
    </>
  );
}
