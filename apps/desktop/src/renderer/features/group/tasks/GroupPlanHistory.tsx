import type { ChatPeer } from "@pibot/client-core";
import { type Group, GroupPlanCardSchema, type Message } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";
import type { GroupSnapshot } from "../data.ts";
import styles from "../group.module.css";
import { GroupPlanCard } from "./GroupPlanCard.tsx";

/** History is read through the existing authorized topic lane, with an explicit bounded page. */
export function GroupPlanHistory({
  peer,
  group,
  bots,
  exclude,
}: {
  peer: ChatPeer;
  group: Group;
  bots: GroupSnapshot["bots"];
  exclude?: string;
}) {
  const t = useT();
  const [pages, setPages] = useState<Message[][]>([]);
  const [cursor, setCursor] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(
    () =>
      peer.on("groups.plan.changed", (event) => {
        if (event.groupId === group.id) {
          setPages([]);
          setCursor(undefined);
          setRevision((value) => value + 1);
        }
      }),
    [peer, group.id],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision retries and refreshes the authorized page.
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setFailed(false);
    void peer
      .call(
        "groups.topics.history",
        { groupId: group.id, topicId: group.conversationId, before: cursor, limit: 50 },
        { signal: abort.signal, timeoutMs: 30_000 },
      )
      .then((page) => {
        if (!abort.signal.aborted) setPages((previous) => (cursor ? [...previous, page] : [page]));
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [peer, group.id, group.conversationId, cursor, revision]);
  const messages = pages.flat();
  const plans = messages.filter((message) => {
    if (message.id === exclude) return false;
    const usage = message.usage;
    return GroupPlanCardSchema.safeParse(
      usage && typeof usage === "object" && !Array.isArray(usage) ? usage.groupPlan : undefined,
    ).success;
  });
  const last = pages.at(-1);
  return (
    // Earlier plans fold into one soft card under the live plan.
    <details className={`${styles.taskFold} ${styles.planHistory}`}>
      <summary>{t("group.plan.history")}</summary>
      {plans.map((message) => (
        <GroupPlanCard key={message.id} message={message} bots={bots} />
      ))}
      {loading && <p role="status">{t("common.loading")}</p>}
      {failed && (
        <p role="alert">
          {t("workspace.failed")}{" "}
          <Button variant="ghost" onClick={() => setRevision((value) => value + 1)}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {!loading && !failed && !plans.length && (
        <p className={styles.note}>{t("execution.empty")}</p>
      )}
      {!loading && last?.length === 50 && pages.length >= 20 && (
        <p className={styles.note}>{t("group.plan.historyTruncated", { count: plans.length })}</p>
      )}
      {!loading && last?.length === 50 && pages.length < 20 && (
        <Button variant="ghost" onClick={() => setCursor(last[0]?.id)}>
          {t("workspace.more")}
        </Button>
      )}
    </details>
  );
}
