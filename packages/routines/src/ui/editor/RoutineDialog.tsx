import type { Routine, RoutineDraft } from "@pibot/protocol";
import { type Peer, useRpc, useSettings, useSettingsDialog } from "@pibot/renderer-kit";
import { Button, CloseButton, Icon, IconTile } from "@pibot/ui";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useRemote, useRoutineAction } from "../shell/remote.ts";
import styles from "../shell/routines.module.css";
import { RunHistory } from "../timeline/RunHistory.tsx";
import { RoutineConfirmation } from "./RoutineConfirmation.tsx";
import { RoutineEditor, routineDraft } from "./RoutineEditor.tsx";
import { useRoutineBot } from "./use-routine-bot.ts";

export function RoutineDialog({
  id,
  botId,
  initial,
  close,
  changed,
}: {
  id?: string;
  botId?: string;
  initial?: import("../shell/navigation.ts").RoutinePrefill;
  close(): void;
  changed(): void;
}) {
  const { peer } = useRpc();
  const { t } = useSettings();
  const title = useId();
  const modal = useSettingsDialog(close);
  const [dirty, setDirty] = useState(false);
  const [confirm, setConfirm] = useState<"leave" | "delete">();
  const deleteButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const previousConfirm = useRef(confirm);
  useLayoutEffect(() => {
    if (!confirm && previousConfirm.current) {
      const opener =
        previousConfirm.current === "delete" ? deleteButton.current : closeButton.current;
      const target = opener && !opener.disabled ? opener : closeButton.current;
      target?.focus({ preventScroll: true });
      if (target === opener) target?.scrollIntoView({ block: "nearest" });
    }
    previousConfirm.current = confirm;
  }, [confirm]);
  const action = useRoutineAction();
  const load = useCallback(
    async (peer: Peer) => {
      if (!id) return null;
      const routine = await peer.call("routines.get", { id });
      if (routine.id !== id || (botId && routine.botId !== botId))
        throw new Error("Routine ownership mismatch");
      return routine;
    },
    [id, botId],
  );
  const remote = useRemote(load);
  const [saved, setSaved] = useState<Routine | null | undefined>(() => (id ? undefined : null));
  // The editor's original version and input lifetime survive remote reads and peer replacement.
  useEffect(() => {
    if (remote.value !== undefined) setSaved((original) => original ?? remote.value);
  }, [remote.value]);
  const conflict = !!saved && !!remote.value && saved.version !== remote.value.version;
  const executionBot = useRoutineBot(remote.value?.botId ?? saved?.botId ?? botId);
  const deleted = !!(remote.value?.deletedAt || saved?.deletedAt);
  const disabled =
    action.disabled || remote.loading || remote.value === undefined || conflict || deleted;
  const requestClose = () => {
    if (confirm) {
      setConfirm(undefined);
      return;
    }
    if (dirty) setConfirm("leave");
    else modal.close();
  };
  const submit = async (draft: RoutineDraft, options: { trialRunId?: string } = {}) => {
    if (!peer || disabled) return;
    const result = await action.run(() =>
      saved
        ? peer.call("routines.update", {
            id: saved.id,
            expectedVersion: saved.version,
            patch: draft,
          })
        : peer.call("routines.create", { ...draft, ...options }),
    );
    if (result) {
      setDirty(false);
      changed();
      modal.close();
    }
  };
  const remove = () => {
    if (!peer || !id || disabled || confirm !== "delete") return;
    void action
      .run(() => peer.call("routines.delete", { id }))
      .then((result) => {
        if (result) {
          changed();
          modal.close();
        }
      });
  };
  const deleteFeedback = [
    action.error && t(action.error),
    remote.error && t(remote.error),
    conflict && t("routines.versionConflict"),
    deleted && t("routines.deleted"),
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <dialog
      ref={modal.dialog}
      aria-labelledby={title}
      tabIndex={-1}
      className={styles.dialog}
      onKeyDown={modal.trapFocus}
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        requestClose();
      }}
    >
      <header className={styles.header}>
        <IconTile icon="clock" tone="orange" />
        <h2 id={title}>{t(id ? "routines.edit" : "routines.new")}</h2>
        <CloseButton ref={closeButton} label={t("workspace.close")} onClick={requestClose} />
      </header>
      <div className={`${styles.body} ${styles.stack}`}>
        {saved?.authorizationError && (
          <p role="alert" className={styles.warn}>
            {t("routines.reauthorizationRequired")}
          </p>
        )}
        {confirm === "leave" && (
          <RoutineConfirmation
            message={t("routines.leave")}
            confirmLabel={t("routines.discard")}
            confirm={modal.close}
            cancel={() => setConfirm(undefined)}
          />
        )}
        {remote.loading && <p role="status">{t("common.loading")}</p>}
        {remote.error && confirm !== "delete" && (
          <p role="alert" className={styles.error}>
            {t(remote.error)} <Button onClick={remote.refresh}>{t("common.retry")}</Button>
          </p>
        )}
        {conflict && confirm !== "delete" && (
          <p role="alert" className={styles.warn}>
            {t("routines.versionConflict")}
          </p>
        )}
        {deleted && confirm !== "delete" && <p className={styles.note}>{t("routines.deleted")}</p>}
        {saved !== undefined && (!deleted || dirty) && (
          <RoutineEditor
            key={`${id ?? "new"}-${saved?.version ?? 0}`}
            saved={saved ?? undefined}
            initial={saved ? routineDraft(saved) : initial}
            botId={botId}
            disabled={disabled || !!confirm}
            onSubmit={submit}
            onDirtyChange={setDirty}
          />
        )}
        {action.error && confirm !== "delete" && (
          <p role="alert" className={styles.error}>
            {t(action.error)}
          </p>
        )}
        {executionBot.unsupported && (
          <p role="alert" className={styles.warn}>
            {t("media.routineReferencesUnsupported")}
          </p>
        )}
        {remote.value && (
          <>
            {remote.value.pausedReason && (
              <p className={styles.warn}>{t(`routines.paused.${remote.value.pausedReason}`)}</p>
            )}
            {confirm !== "delete" && (
              <div className={styles.manageRow}>
                <Button
                  variant="secondary"
                  disabled={
                    disabled ||
                    dirty ||
                    !!confirm ||
                    (!remote.value.enabled && executionBot.blocked)
                  }
                  onClick={() => {
                    if (
                      peer &&
                      id &&
                      remote.value &&
                      (remote.value.enabled || !executionBot.blocked)
                    )
                      void action
                        .run(() =>
                          peer.call("routines.setEnabled", { id, enabled: !remote.value?.enabled }),
                        )
                        .then((r) => {
                          if (r) {
                            changed();
                            setSaved(undefined);
                            remote.refresh();
                          }
                        });
                  }}
                >
                  {t(remote.value.enabled ? "routines.disable" : "routines.enable")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={disabled || !!confirm || executionBot.blocked}
                  onClick={() => {
                    if (peer && id && !executionBot.blocked)
                      void action
                        .run(() => peer.call("routines.runNow", { id }))
                        .then((r) => {
                          if (r) changed();
                        });
                  }}
                >
                  <Icon name="play" size={13} />
                  {t("routines.runNow")}
                </Button>
                {remote.value.pausedReason === "away_7d" && (
                  <Button
                    variant="secondary"
                    disabled={disabled || dirty || !!confirm || executionBot.blocked}
                    onClick={() => {
                      if (peer && id && !executionBot.blocked)
                        void action
                          .run(() => peer.call("routines.resumeAway", { ids: [id] }))
                          .then((r) => {
                            if (r) {
                              changed();
                              setSaved(undefined);
                              remote.refresh();
                            }
                          });
                    }}
                  >
                    {t("routines.resumeOne")}
                  </Button>
                )}
                <Button
                  ref={deleteButton}
                  variant="ghost"
                  className={styles.dangerButton}
                  disabled={disabled || !!confirm}
                  onClick={() => setConfirm("delete")}
                >
                  {t("common.delete")}
                </Button>
              </div>
            )}
          </>
        )}
        {confirm === "delete" && (
          <RoutineConfirmation
            message={t("routines.confirmDelete")}
            confirmLabel={t("common.delete")}
            disabled={disabled}
            feedback={deleteFeedback || undefined}
            retry={remote.error ? remote.refresh : undefined}
            retryDisabled={action.busy || remote.loading || !peer}
            confirm={remove}
            cancel={() => setConfirm(undefined)}
          />
        )}
        {remote.value && <RunHistory routineId={remote.value.id} botId={remote.value.botId} />}
      </div>
    </dialog>
  );
}
