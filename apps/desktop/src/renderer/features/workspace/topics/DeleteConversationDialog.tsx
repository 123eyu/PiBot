import { RpcError } from "@pibot/protocol";
import { actionError, useAction, useRpc, useT } from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { Overlay } from "../Overlay.tsx";
import styles from "../workspace.module.css";

export function DeleteConversationDialog({
  target,
  close,
  deleted,
  permanent = false,
  name,
}: {
  target: { botId: string } | { groupId: string };
  close(): void;
  deleted(): void;
  permanent?: boolean;
  name?: string;
}) {
  const t = useT();
  const { peer } = useRpc();
  const task = useAction();
  const label = permanent
    ? "groupId" in target
      ? "workspace.dissolveArchived"
      : "workspace.deletePermanently"
    : "groupId" in target
      ? "group.archive"
      : "workspace.archiveBot";
  return (
    <Overlay icon="trash" tone="red" title={t(label)} close={close} busy={task.busy}>
      {name && <p>{name}</p>}
      <p>
        {t(
          permanent
            ? "workspace.confirmPermanent"
            : "groupId" in target
              ? "group.archiveHint"
              : "workspace.confirmBot",
        )}
      </p>
      <div className={`${styles.actions} ${styles.actionsEnd}`}>
        <Button variant="secondary" disabled={task.busy} onClick={close}>
          {t("common.cancel")}
        </Button>
        <Button
          // Archiving can be undone from 已归档, so only permanent deletion looks destructive.
          className={permanent ? styles.deleteButton : undefined}
          disabled={!peer || task.busy}
          loading={task.busy}
          onClick={() => {
            if (!peer) return;
            void task
              .run<unknown>(
                (signal) =>
                  "groupId" in target
                    ? permanent
                      ? peer.call(
                          "groups.delete",
                          { groupId: target.groupId, confirmed: true },
                          { signal, timeoutMs: 30000 },
                        )
                      : peer.call(
                          "groups.archive",
                          { groupId: target.groupId },
                          { signal, timeoutMs: 30000 },
                        )
                    : permanent
                      ? peer.call(
                          "bots.delete",
                          { botId: target.botId, confirmed: true },
                          { signal, timeoutMs: 30000 },
                        )
                      : peer.call(
                          "bots.archive",
                          { botId: target.botId },
                          { signal, timeoutMs: 30000 },
                        ),
                (error) =>
                  error instanceof RpcError && error.message === "bot_archive_has_groups"
                    ? "workspace.deleteBotHasGroups"
                    : actionError(error),
              )
              .then((result) => {
                if (result) deleted();
              });
          }}
        >
          {permanent && <Icon name="trash" />}
          {t(label)}
        </Button>
      </div>
      {task.error && (
        <p role="alert" className={styles.error}>
          {t(task.error)}
        </p>
      )}
    </Overlay>
  );
}
