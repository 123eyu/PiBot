import { ProviderTile } from "@pibot/models/ui";
import { useNavigation, useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { AppDialog } from "../AppDialog.tsx";
import styles from "./conversation-import.module.css";
import { ImportPreview } from "./ImportPreview.tsx";
import { ImportProgress } from "./ImportProgress.tsx";
import { localSources, marks, sources, startParams } from "./import-state.ts";
import { useImportDraft } from "./use-import-draft.ts";
import { useImportJob } from "./use-import-job.ts";

export function ConversationImportDialog({ open, close }: { open: boolean; close(): void }) {
  const t = useT();
  const { peer } = useRpc();
  const { openBotPanel, openWorkspace } = useNavigation();
  const draft = useImportDraft();
  const running = useImportJob();
  // Keep the batch subscription mounted when the existing inbox opens for project approval.
  if (!open) return null;
  const { preview } = draft;
  const status = running.job?.status;
  const title = status?.cleanupBlocked
    ? "conversationImport.cleanupBlocked"
    : status?.cleanup === "discarding"
      ? "conversationImport.cleaning"
      : status
        ? (`conversationImport.state.${status.state}` as const)
        : running.job
          ? "conversationImport.confirming"
          : "conversationImport.title";
  const busy = !!draft.busy || !!running.busy || !peer;
  const params =
    preview &&
    startParams({
      ...draft,
      preview,
      project: draft.projectConfirmed ? draft.project : undefined,
    });
  const release = () => {
    if (!running.job) draft.back();
    close();
  };
  return (
    <AppDialog
      title={t(title)}
      kind="conversation-import"
      mark={{ icon: "download", tone: "teal" }}
      busy={!!draft.busy || running.busy === "start"}
      close={release}
    >
      {running.job ? (
        <ImportProgress
          running={running}
          restart={() => {
            running.clear();
            draft.back();
          }}
          openInbox={() => {
            close();
            openWorkspace({ name: "inbox" });
          }}
          openTopics={(botId) => {
            close();
            openBotPanel(botId, "topics");
          }}
          close={close}
        />
      ) : (
        <>
          {preview ? (
            <ImportPreview draft={draft} preview={preview} disabled={busy} />
          ) : (
            <>
              <p className={styles.intro}>{t("conversationImport.chooseSource")}</p>
              <fieldset
                className={styles.sources}
                aria-label={t("conversationImport.sources")}
                disabled={busy}
              >
                {sources.map((source) => (
                  <ProviderTile
                    key={source}
                    name={t(`conversationImport.source.${source}`)}
                    note={t(`conversationImport.sourceNote.${source}`)}
                    group="common"
                    monogram={marks[source]}
                    selected={source === draft.source}
                    onClick={() => draft.selectSource(source)}
                  />
                ))}
              </fieldset>
            </>
          )}
          {draft.busy && (
            <p className={styles.intro} role="status">
              {t(`conversationImport.loading.${draft.busy}`)}
            </p>
          )}
          {(draft.error || running.error) && (
            <p className={styles.error} role="alert">
              {t(draft.error ?? running.error ?? "conversationImport.error.internal")}
            </p>
          )}
          <div className={styles.actions}>
            <Button
              variant="secondary"
              disabled={busy && !!peer}
              onClick={preview ? draft.back : release}
            >
              {t(preview ? "common.back" : "common.cancel")}
            </Button>
            {preview ? (
              <Button disabled={busy || !params} onClick={() => params && running.start(params)}>
                {t("conversationImport.start")}
              </Button>
            ) : (
              <Button disabled={busy} onClick={draft.pick}>
                {t(
                  localSources.has(draft.source)
                    ? "conversationImport.pickLocal"
                    : "conversationImport.pickExport",
                )}
              </Button>
            )}
          </div>
        </>
      )}
    </AppDialog>
  );
}
