import { type FolderModel, SettingsPage, useNavigation, useRpc, useT } from "@pibot/renderer-kit";
import { Icon, IconTile } from "@pibot/ui";
import { useEffect, useState } from "react";
import { AppDialog } from "../../../app-menu/AppDialog.tsx";
import { MemoryScopeView } from "../settings/MemoryScopeView.tsx";
import styles from "./project-memory.module.css";
import {
  PROJECT_MEMORY_DIALOG,
  type ProjectMemoryDialogState,
  projectMemoryDialog,
} from "./project-memory-dialog.ts";

/**
 * Project memory belongs to the working folder, so it is opened from the folder menu.
 * The Bot's own folder and remote folders are not projects; nothing is shown for them.
 */
export function ProjectMemoryFolderMenu({ model }: { model: FolderModel }) {
  const t = useT();
  const { peer } = useRpc();
  const { showDialog } = useNavigation();
  const primary = model.primary;
  const path = primary.id !== "home" && !primary.location ? primary.path : undefined;
  const [projectId, setProjectId] = useState<string | null>();
  useEffect(() => {
    setProjectId(undefined);
    if (!peer || !path) return;
    const controller = new AbortController();
    void peer
      .call("memory.project", { path }, { signal: controller.signal, timeoutMs: 10_000 })
      .then((result) => {
        if (!controller.signal.aborted) setProjectId(result.projectId);
      })
      .catch(() => {
        if (!controller.signal.aborted) setProjectId(null);
      });
    return () => controller.abort();
  }, [peer, path]);
  if (!path) return null;
  return (
    <div className={styles.menu}>
      {/* Maintainers 2026-11-12: a row like the folder menu's own entries, not a bold standalone button. */}
      <button
        type="button"
        className={styles.item}
        disabled={projectId === undefined}
        onClick={() => showDialog(() => projectMemoryDialog(projectId ?? null, primary.name))}
      >
        <IconTile icon="briefcase" tone="amber" size="sm" />
        <span className={styles.text}>{t("projectMemory.open")}</span>
        <Icon name="chevronRight" size={13} className={styles.chevron} />
      </button>
    </div>
  );
}

export function ProjectMemoryDialog() {
  const { dialog, closeDialog } = useNavigation();
  const t = useT();
  if (dialog?.owner !== PROJECT_MEMORY_DIALOG) return null;
  const state = dialog.state as ProjectMemoryDialogState;
  return (
    <AppDialog
      key={dialog.key}
      mark={{ icon: "briefcase", tone: "amber" }}
      title={
        state.name
          ? t("projectMemory.title", { name: state.name })
          : t("projectMemory.titleGeneric")
      }
      close={() => closeDialog(dialog.key)}
    >
      <SettingsPage lead={t("projectMemory.lead")}>
        {state.projectId ? (
          <MemoryScopeView owner={{ scope: "project", ownerId: state.projectId }} />
        ) : (
          <p className={styles.empty}>{t("projectMemory.empty")}</p>
        )}
      </SettingsPage>
    </AppDialog>
  );
}
