import type { ChatNotice } from "@pibot/protocol";
import { folderError, useAction, useRpc, useT } from "@pibot/renderer-kit";
import { Button, Chip, Icon, IconTile } from "@pibot/ui";
import { memo } from "react";
import styles from "../autocheck/auto-check.module.css";

type MoveNotice = Extract<ChatNotice, { kind: "workplace_move_proposal" }>;

/**
 * A Bot proposed moving this topic's working folder onto a paired runner. Only the person's
 * answer here changes anything; YOLO, grants and routines never answer it.
 */
export const RunnerMoveCard = memo(function RunnerMoveCard({
  notice,
  botName,
}: {
  notice: MoveNotice;
  botName: string;
}) {
  const t = useT();
  const { peer } = useRpc();
  const task = useAction();
  const pending = notice.status === "pending";
  const resolve = (accept: boolean) => {
    if (!peer) return;
    void task.run(
      () => peer.call("remote.workplaceMove.resolve", { noticeId: notice.id, accept }),
      (error) =>
        error instanceof Error && error.message === "workplace_move_closed"
          ? "remote.runner.moveClosed"
          : folderError(error),
    );
  };
  const title = t("remote.runner.moveTitle", { name: botName });
  return (
    <section className={styles.card} aria-label={title}>
      <div className={styles.cardHead}>
        <IconTile icon="server" tone="teal" />
        <span>{title}</span>
      </div>
      <p className={styles.cardSub}>
        {t("remote.runner.moveTarget", { runner: notice.runnerName, folder: notice.path })}
        {notice.note ? ` · ${notice.note}` : ""}
      </p>
      {pending && <p className={styles.cardSub}>{t("remote.runner.moveIntro")}</p>}
      {pending ? (
        <div className={styles.actions}>
          <Button variant="ghost" disabled={task.busy || !peer} onClick={() => resolve(false)}>
            {t("remote.runner.moveDecline")}
          </Button>
          <Button
            variant="primary"
            className={styles.accept}
            loading={task.busy}
            disabled={!peer}
            onClick={() => resolve(true)}
          >
            {t("remote.runner.moveAccept")}
          </Button>
        </div>
      ) : (
        <div className={styles.cardResult}>
          <Chip tone={notice.status === "accepted" ? "ok" : "neutral"}>
            {notice.status === "accepted" && <Icon name="check" size={12} />}
            {t(
              notice.status === "accepted"
                ? "remote.runner.moveAccepted"
                : "remote.runner.moveDeclined",
            )}
          </Chip>
        </div>
      )}
      {task.error && (
        <p role="alert" className={styles.error}>
          {t(task.error)}
        </p>
      )}
    </section>
  );
});
