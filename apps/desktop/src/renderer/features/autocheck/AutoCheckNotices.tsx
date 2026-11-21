import type { ChatNotice } from "@pibot/protocol";
import { useAction, useRpc, useT } from "@pibot/renderer-kit";
import { Button, Chip, type DotState, Icon, IconTile, StatusDot } from "@pibot/ui";
import { memo, useState } from "react";
import styles from "./auto-check.module.css";
import { durationText, parseCommands } from "./commands.ts";

type CheckNotice = Extract<ChatNotice, { kind: "auto_check" }>;
type ProposalNotice = Extract<ChatNotice, { kind: "auto_check_proposal" }>;

const tones = {
  running: "muted",
  passed: "ok",
  failed: "danger",
  timeout: "danger",
  blocked: "warn",
  stopped: "muted",
} as const;
const dots: Record<CheckNotice["status"], DotState> = {
  running: "running",
  passed: "done",
  failed: "failed",
  timeout: "failed",
  blocked: "waiting",
  stopped: "stopped",
};

/** One automatic check under the reply it checked; output folded by default. */
export const AutoCheckResult = memo(function AutoCheckResult({
  notice,
  botName,
}: {
  notice: CheckNotice;
  botName: string;
}) {
  const t = useT();
  const index = notice.failedIndex ?? notice.commands.length - 1;
  const command =
    notice.status === "passed" || notice.status === "running"
      ? notice.commands.join(" && ")
      : (notice.commands[index] ?? notice.commands[0] ?? "");
  const duration = durationText(notice.durationMs, t);
  const title =
    notice.failureKind === "environment"
      ? t("autoCheck.notice.environment", { command })
      : notice.status === "running"
        ? t("autoCheck.notice.running", { command })
        : notice.status === "passed"
          ? t("autoCheck.notice.passed", { command, duration })
          : notice.status === "failed"
            ? typeof notice.exitCode === "number"
              ? t("autoCheck.notice.failed", { command, code: notice.exitCode, duration })
              : t("autoCheck.notice.failedUnknown", { command, duration })
            : notice.status === "timeout"
              ? t("autoCheck.notice.timeout", { command, duration })
              : notice.status === "blocked"
                ? t("autoCheck.notice.blocked", { command })
                : t("autoCheck.notice.stopped", { command });
  const tone = tones[notice.status];
  const lines = notice.tail ? notice.tail.split("\n").length : 0;
  const failed = notice.status === "failed" || notice.status === "timeout";
  return (
    <section
      className={styles.result}
      data-tone={tone}
      data-state={notice.status}
      aria-label={t("autoCheck.title")}
      aria-live={notice.status === "running" ? "polite" : undefined}
    >
      <div className={styles.head}>
        <StatusDot state={dots[notice.status]} />
        <span className={styles.title}>{title}</span>
        {notice.round > 0 && (
          <Chip tone="warn" className={styles.round}>
            {t("autoCheck.notice.afterFix", { round: notice.round, max: notice.maxRounds })}
          </Chip>
        )}
      </div>
      {!!notice.reusedChecks?.length && (
        <p className={styles.followUp}>
          {t("autoCheck.notice.reused", {
            commands: notice.reusedChecks.map(({ index }) => notice.commands[index]).join(" · "),
          })}
        </p>
      )}
      {notice.failureKind === "environment" && (
        <p className={styles.followUp}>{t("autoCheck.notice.environmentHint")}</p>
      )}
      {failed && notice.followUp && (
        <p className={styles.followUp}>{t("autoCheck.notice.followUp", { name: botName })}</p>
      )}
      {failed && notice.limitReached && (
        <p className={styles.limit} role="status">
          {notice.maxRounds > 0
            ? t("autoCheck.notice.limit", { max: notice.maxRounds })
            : t("autoCheck.notice.limitNone")}
        </p>
      )}
      {notice.tail && (
        <details className={styles.details}>
          <summary>
            {notice.status === "blocked"
              ? t("autoCheck.notice.reason")
              : t("autoCheck.notice.output", { lines })}
          </summary>
          <pre className={styles.tail}>{notice.tail}</pre>
        </details>
      )}
    </section>
  );
});

/** The Bot's proposed check commands for this folder; saved only when the user says so. */
export const AutoCheckProposal = memo(function AutoCheckProposal({
  notice,
  botName,
}: {
  notice: ProposalNotice;
  botName: string;
}) {
  const t = useT();
  const { peer } = useRpc();
  const task = useAction();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(notice.commands.join("\n"));
  const [invalid, setInvalid] = useState(false);
  const pending = notice.status === "pending";
  const folder = notice.folderName || t("autoCheck.folderHome", { name: botName });
  const resolve = async (accept: boolean) => {
    if (!peer) return;
    const commands = accept && editing ? parseCommands(draft) : undefined;
    if (accept && editing && !commands) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const done = await task.run(
      () =>
        peer.call("autoCheck.proposal.resolve", {
          noticeId: notice.id,
          accept,
          ...(commands ? { commands } : {}),
        }),
      (error) =>
        error instanceof Error && error.message === "autocheck_proposal_closed"
          ? "autoCheck.proposal.closed"
          : "autoCheck.failed",
    );
    if (done) setEditing(false);
  };
  return (
    <section className={styles.card} aria-label={t("autoCheck.proposal.title", { name: botName })}>
      <div className={styles.cardHead}>
        <IconTile icon="check" tone="teal" />
        <span>{t("autoCheck.proposal.title", { name: botName })}</span>
      </div>
      <p className={styles.cardSub}>
        {t("autoCheck.proposal.folder", { folder })}
        {notice.note ? ` · ${notice.note}` : ""}
      </p>
      {editing ? (
        <label className={styles.editor}>
          {t("autoCheck.commandsLabel")}
          <textarea
            value={draft}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
          />
          {invalid && <span role="alert">{t("autoCheck.commandsInvalid")}</span>}
        </label>
      ) : (
        <ul className={styles.commands}>
          {notice.commands.map((command) => (
            <li key={command}>
              <code>{command}</code>
            </li>
          ))}
        </ul>
      )}
      {pending && <p className={styles.cardSub}>{t("autoCheck.proposal.intro")}</p>}
      {pending ? (
        <div className={styles.actions}>
          <Button variant="ghost" disabled={task.busy || !peer} onClick={() => resolve(false)}>
            {t("autoCheck.proposal.decline")}
          </Button>
          {!editing && (
            <Button variant="secondary" disabled={task.busy} onClick={() => setEditing(true)}>
              {t("autoCheck.edit")}
            </Button>
          )}
          <Button
            variant="primary"
            className={styles.accept}
            loading={task.busy}
            disabled={!peer}
            onClick={() => resolve(true)}
          >
            {t("autoCheck.proposal.accept")}
          </Button>
        </div>
      ) : (
        <div className={styles.cardResult}>
          <Chip tone={notice.status === "accepted" ? "ok" : "neutral"}>
            {notice.status === "accepted" && <Icon name="check" size={12} />}
            {t(
              notice.status === "accepted"
                ? "autoCheck.proposal.accepted"
                : "autoCheck.proposal.declined",
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
