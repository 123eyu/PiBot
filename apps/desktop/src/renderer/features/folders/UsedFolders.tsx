import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { Overlay, botPanelStyles as styles, useRpc, useRpcEvent, useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import folderStyles from "./used-folders.module.css";

type Owner = { botId: string; groupId?: never } | { groupId: string; botId?: never };
type Folder = { id: string; name: string; topicCount?: number; routineCount?: number };

/** Both profiles open identities from their own registry, never paths remembered by the UI. */
export function UsedFolders(owner: Owner) {
  const { botId, groupId } = owner;
  const { peer } = useRpc();
  const t = useT();
  const key = groupId ? `group:${groupId}` : `dm:${botId}`;
  const [rows, setRows] = useState<{ peer: typeof peer; key: string; folders: Folder[] }>();
  const [error, setError] = useState(false);
  const [failed, setFailed] = useState<"failed" | "unsupported">();
  const [busy, setBusy] = useState<string>();
  const [confirmation, setConfirmation] = useState<{
    peer: typeof peer;
    key: string;
    folder: Folder;
  }>();
  const [forgotten, setForgotten] = useState<{ peer: typeof peer; key: string; count: number }>();
  const reading = useRef<AbortController | undefined>(undefined);
  const action = useRef<AbortController | undefined>(undefined);
  const load = useCallback(() => {
    reading.current?.abort();
    if (!peer) return;
    const controller = new AbortController();
    reading.current = controller;
    setError(false);
    const options = { signal: controller.signal, timeoutMs: 20_000 };
    const request = groupId
      ? peer.call("groups.folders.used", { groupId }, options)
      : peer.call("workplaces.used", { botId: botId as string }, options);
    void request.then(
      (result) => {
        if (!controller.signal.aborted) setRows({ peer, key, folders: result.folders });
      },
      () => {
        if (!controller.signal.aborted) setError(true);
      },
    );
  }, [peer, botId, groupId, key]);
  useEffect(() => {
    setBusy(undefined);
    setFailed(undefined);
    setConfirmation(undefined);
    setForgotten(undefined);
    load();
    return () => {
      reading.current?.abort();
      action.current?.abort();
      action.current = undefined;
    };
  }, [load]);
  useRpcEvent("bots.changed", (event) => {
    if (event.botId === botId) load();
  });
  useRpcEvent("groups.changed", (event) => {
    if (event.groupId === groupId) load();
  });
  useRpcEvent("sidebar.changed", (event) => {
    if (event.conversationKey === key) load();
  });
  const runAction = async (folderId: string, perform: (signal: AbortSignal) => Promise<void>) => {
    if (action.current) return;
    const controller = new AbortController();
    action.current = controller;
    setBusy(folderId);
    setFailed(undefined);
    try {
      await perform(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted)
        setFailed(
          error instanceof RpcError && error.code === RpcErrorCodes.unsupported
            ? "unsupported"
            : "failed",
        );
    } finally {
      if (action.current === controller) {
        action.current = undefined;
        setBusy(undefined);
      }
    }
  };
  const reveal = (folderId: string) => {
    if (!peer) return;
    void runAction(folderId, async (signal) => {
      const options = { signal, timeoutMs: 20_000 };
      if (groupId) await peer.call("groups.folders.reveal", { groupId, folderId }, options);
      else await peer.call("workplaces.reveal", { botId: botId as string, folderId }, options);
    });
  };
  const pending =
    confirmation && confirmation.peer === peer && confirmation.key === key
      ? confirmation
      : undefined;
  const forget = () => {
    if (!peer || !botId || !pending) return;
    const folderId = pending.folder.id;
    void runAction(folderId, async (signal) => {
      const result = await peer.call(
        "workplaces.forget",
        { botId, folderId },
        {
          signal,
          timeoutMs: 20_000,
        },
      );
      if (signal.aborted) return;
      setConfirmation(undefined);
      setForgotten({ peer, key, count: result.inUse });
      setRows((current) =>
        current && current.peer === peer && current.key === key
          ? { ...current, folders: current.folders.filter((folder) => folder.id !== folderId) }
          : current,
      );
      // Refresh through the registry: hiding a record does not remove its topic/routine bindings.
      load();
    });
  };
  const dismiss = () => {
    setConfirmation(undefined);
    setFailed(undefined);
  };
  const folders = rows && rows.peer === peer && rows.key === key ? rows.folders : undefined;
  const failureMessage = failed === "unsupported" ? "log.unsupported" : "log.actionError";
  return (
    <section className={styles.section}>
      <h2>{t("folders.usedTitle")}</h2>
      <p className={styles.note}>{t(groupId ? "folders.groupUsedNote" : "folders.usedNote")}</p>
      {error ? (
        <p role="alert" className={styles.error}>
          {t("folders.usedError")}{" "}
          <Button variant="pill" onClick={load}>
            {t("common.retry")}
          </Button>
        </p>
      ) : (
        <div className={styles.card}>
          {[
            { id: "home", name: t(groupId ? "folders.groupHome" : "folders.home") },
            ...(folders ?? []),
          ].map((folder) => {
            const removable = !!botId && folder.id !== "home";
            const open = (
              <button
                key={folder.id}
                type="button"
                className={`${styles.rowButton} ${removable ? folderStyles.open : styles.cardRow}`}
                title={t("folders.open")}
                aria-label={`${folder.name} · ${t("folders.open")}`}
                disabled={!peer || !!busy}
                onClick={() => reveal(folder.id)}
              >
                <IconTile icon="folder" tone="amber" size="lg" />
                <span className={styles.folderName}>{folder.name}</span>
              </button>
            );
            return removable ? (
              <div key={folder.id} className={`${styles.cardRow} ${folderStyles.row}`}>
                {open}
                <Button
                  variant="ghost"
                  className={folderStyles.forget}
                  disabled={!peer || !!busy}
                  aria-label={t("folders.forgetNamed", { name: folder.name })}
                  onClick={() => {
                    setFailed(undefined);
                    setForgotten(undefined);
                    setConfirmation({ peer, key, folder });
                  }}
                >
                  {t("folders.forget")}
                </Button>
              </div>
            ) : (
              open
            );
          })}
        </div>
      )}
      {forgotten && forgotten.peer === peer && forgotten.key === key && (
        <p role="status" className={styles.note}>
          {t("folders.forgotten", { count: forgotten.count })}
        </p>
      )}
      {pending && (
        <Overlay
          icon="folder"
          tone="amber"
          title={t("folders.forgetNamed", { name: pending.folder.name })}
          busy={!!busy}
          close={dismiss}
        >
          <p>
            {t("folders.forgetHint", {
              count: (pending.folder.topicCount ?? 0) + (pending.folder.routineCount ?? 0),
            })}
          </p>
          <div className={folderStyles.actions}>
            <Button
              data-dialog-initial-focus
              variant="secondary"
              disabled={!!busy}
              onClick={dismiss}
            >
              {t("common.cancel")}
            </Button>
            <Button disabled={!peer} loading={!!busy} onClick={forget}>
              {t("folders.forget")}
            </Button>
          </div>
          {failed && (
            <p role="alert" className={styles.error}>
              {t(failureMessage)}
            </p>
          )}
        </Overlay>
      )}
      {failed && !pending && (
        <p role="alert" className={styles.error}>
          {t(failureMessage)}
        </p>
      )}
    </section>
  );
}
