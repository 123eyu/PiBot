import type { ComputerStep } from "@pibot/computer-use-contract/full";
import { useRpc, useRpcEvent, useSettings } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "../computer.module.css";
import { computerErrorKey } from "../presentation.ts";
import { StepRow } from "./StepRow.tsx";

const PAGE = 50;
const MAX_KEPT = 1000;

/**
 * Sidebar "Records" · computer tab: every recorded step across runs, newest first, paged
 * with `before`; live steps are prepended. Screenshots load lazily per visible row.
 */
export function ComputerStepsLog({
  botId,
  groupId,
  from,
  onVisibleCount,
  botName,
}: {
  botId: string;
  groupId?: string;
  from?: string;
  onVisibleCount?(count: number): void;
  botName(id: string): string | undefined;
}) {
  const { t, language } = useSettings();
  const { peer } = useRpc();
  const [steps, setSteps] = useState<ComputerStep[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ReturnType<typeof computerErrorKey>>();
  const generation = useRef(0);
  const cursor = useRef<string | undefined>(undefined);
  const groupRefresh = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useCallback(
    async (fresh: boolean) => {
      if (!peer) return;
      const version = fresh ? ++generation.current : generation.current;
      if (fresh) cursor.current = undefined;
      setLoading(true);
      setError(undefined);
      try {
        const page = await peer.call("computer.steps", {
          limit: PAGE,
          from,
          ...(botId ? { botId } : {}),
          ...(groupId ? { groupId } : {}),
          ...(cursor.current ? { before: cursor.current } : {}),
        });
        if (version !== generation.current) return;
        cursor.current = page.at(-1)?.id ?? cursor.current;
        setSteps((old) => {
          const base = fresh ? [] : old;
          const seen = new Set(base.map((step) => step.id));
          return [...base, ...page.filter((step) => !seen.has(step.id))].slice(0, MAX_KEPT);
        });
        setMore(page.length === PAGE);
      } catch (e) {
        if (version === generation.current) setError(computerErrorKey(e));
      } finally {
        if (version === generation.current) setLoading(false);
      }
    },
    [peer, botId, groupId, from],
  );
  useEffect(() => {
    void load(true);
    return () => {
      generation.current++;
      clearTimeout(groupRefresh.current);
      groupRefresh.current = undefined;
    };
  }, [load]);
  useEffect(() => {
    onVisibleCount?.(steps.length);
  }, [steps.length, onVisibleCount]);
  useRpcEvent("computer.step", ({ step }) => {
    if (from && step.createdAt < from) return;
    if (botId && step.botId !== botId) return;
    if (groupId) {
      if (!groupRefresh.current)
        groupRefresh.current = setTimeout(() => {
          groupRefresh.current = undefined;
          void load(true);
        }, 250);
      return;
    }
    setSteps((old) =>
      old.some((item) => item.id === step.id)
        ? old.map((item) => (item.id === step.id ? step : item))
        : [step, ...old].slice(0, MAX_KEPT),
    );
  });
  const days = new Map<string, ComputerStep[]>();
  for (const step of steps) {
    const label = new Date(step.createdAt).toLocaleDateString(language, {
      month: "long",
      day: "numeric",
      weekday: "short",
    });
    const list = days.get(label);
    if (list) list.push(step);
    else days.set(label, [step]);
  }
  return (
    <>
      <p className={styles.chatNote}>{t("computerUse.log.note")}</p>
      {[...days].map(([label, group]) => (
        <section key={label} aria-label={label} className={styles.logDay}>
          <h2>{label}</h2>
          {group.map((step) => (
            <StepRow
              key={step.id}
              step={step}
              extra={[
                botName(step.botId),
                new Date(step.createdAt).toLocaleTimeString(language, {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          ))}
        </section>
      ))}
      {loading && <p role="status">{t("common.loading")}</p>}
      {error && (
        <p role="alert" className={styles.stepsError}>
          {t(error)}
          <Button variant="pill" disabled={loading} onClick={() => void load(!steps.length)}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {!steps.length && !loading && !error && (
        <p className={styles.chatNote}>{t("computerUse.log.empty")}</p>
      )}
      {more && !error && (
        <Button variant="pill" disabled={loading} onClick={() => void load(false)}>
          {t("activity.more")}
        </Button>
      )}
    </>
  );
}
