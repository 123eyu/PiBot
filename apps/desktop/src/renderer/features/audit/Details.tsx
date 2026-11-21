import { auditFactRows, auditGroup, auditResult, auditSummary } from "@pibot/client-core";
import type { AuditEntry } from "@pibot/protocol";
import { useAction, useNavigation, useRpc, useSettings } from "@pibot/renderer-kit";
import { Button, Chip, Icon } from "@pibot/ui";
import { useEffect, useState } from "react";
import { RunLogButton } from "../run-log/Viewer.tsx";
import styles from "./audit.module.css";
import { auditCommandSource, locateAuditConversation } from "./links.ts";
import { activityMark } from "./marks.ts";

export function AuditDetails({
  entry,
  loadedSource,
  botName,
}: {
  entry: AuditEntry;
  loadedSource?: AuditEntry;
  botName?: string;
}) {
  const { peer } = useRpc();
  const { t } = useSettings();
  const { navigate } = useNavigation();
  const task = useAction();
  const [context, setContext] = useState<{
    source?: AuditEntry;
    loading: boolean;
    error: boolean;
  }>({ loading: true, error: false });
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision retries only the selected record's supplementary facts.
  useEffect(() => {
    const lifetime = new AbortController();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), 30_000);
    const signal = AbortSignal.any([lifetime.signal, deadline.signal]);
    setContext({ source: loadedSource, loading: true, error: false });
    if (peer)
      void (loadedSource ? Promise.resolve(loadedSource) : auditCommandSource(peer, entry, signal))
        .then((source) => {
          if (!lifetime.signal.aborted) setContext({ source, loading: false, error: false });
        })
        .catch(() => {
          if (!lifetime.signal.aborted)
            setContext({ source: loadedSource, loading: false, error: true });
        });
    else setContext({ source: loadedSource, loading: false, error: true });
    return () => {
      lifetime.abort();
      clearTimeout(timer);
    };
  }, [peer, entry, loadedSource, revision]);
  const detail = { ...context.source?.detail, ...entry.detail };
  const enriched = { ...entry, detail };
  const facts = auditFactRows(enriched, t, botName);
  const content = auditSummary(enriched, t, { botName });
  const group = auditGroup(entry);
  const result = auditResult(entry, t);
  const hasLog =
    entry.kind === "exec.finished" && typeof entry.detail.exitCode === "number" && !!entry.runId;
  const openChat = () => {
    if (peer)
      void task
        .run(
          async (signal) => {
            const deadline = new AbortController();
            const timer = setTimeout(() => deadline.abort(), 30_000);
            try {
              return await locateAuditConversation(
                peer,
                entry,
                AbortSignal.any([signal, deadline.signal]),
              );
            } finally {
              clearTimeout(timer);
            }
          },
          () => "activity.chatUnavailable",
        )
        .then((target) => {
          if (target) navigate(target);
        });
  };
  return (
    <div className={styles.details}>
      <div className={styles.detailStatus}>
        <Chip tone={activityMark(group).tone}>
          {t(group === "identity" ? "audit.kind.oauth.changed" : `activity.kind.${group}`)}
        </Chip>
        <span className={styles.result} data-tone={result.tone}>
          {result.text}
        </span>
      </div>
      <pre>{content}</pre>
      <dl className={styles.facts}>
        {[...new Map(facts.map((fact) => [`${fact.label}:${fact.value}`, fact])).entries()].map(
          ([key, fact]) => (
            <div key={key}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ),
        )}
      </dl>
      {context.loading && (
        <p className={styles.note} role="status">
          {t("common.loading")}
        </p>
      )}
      {context.error && (
        <p className={styles.danger} role="alert">
          {t("activity.detailsError")}{" "}
          <Button variant="pill" onClick={() => setRevision((value) => value + 1)}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {!context.loading &&
        entry.kind === "exec.finished" &&
        !detail.target &&
        !detail.programs?.length && <p className={styles.note}>{t("activity.noCommand")}</p>}
      {!context.loading && !facts.length && <p className={styles.note}>{t("activity.noFacts")}</p>}
      <div className={styles.links}>
        {!!entry.runId && (
          <button
            type="button"
            className={styles.primaryLink}
            disabled={task.busy}
            onClick={openChat}
          >
            {t("activity.openChat")} <Icon name="arrow" size={13} />
          </button>
        )}
        {hasLog && (
          <RunLogButton
            details={{
              runId: entry.runId as string,
              ...(detail.toolCallId ? { toolCallId: detail.toolCallId } : {}),
              botId: entry.botId,
              command: content,
              exitCode: entry.detail.exitCode ?? null,
              durationMs: detail.durationMs ?? null,
            }}
          />
        )}
      </div>
      {task.error && (
        <p className={styles.danger} role="alert">
          {t(task.error)}
        </p>
      )}
    </div>
  );
}
