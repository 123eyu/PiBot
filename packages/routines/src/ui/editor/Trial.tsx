import type { RoutinePreauthInput } from "@pibot/protocol";
import { useRpc, useSettings, waitRpc } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useState } from "react";
import { operationKey } from "../preauth/PreauthEditor.tsx";
import { operationText } from "../preauth/preauth.ts";
import { routineError } from "../shell/remote.ts";
import styles from "../shell/routines.module.css";
import { activeRun, RunRow, type RunView } from "../timeline/RunHistory.tsx";

export function Trial({
  id,
  botId,
  remember,
  current = true,
  disabled = false,
  running,
  imageReferencesUnsupported = false,
}: {
  id: string;
  botId: string;
  remember(ops: RoutinePreauthInput[]): void;
  current?: boolean;
  disabled?: boolean;
  running(active: boolean): void;
  imageReferencesUnsupported?: boolean;
}) {
  const { peer } = useRpc();
  const { t } = useSettings();
  const [run, setRun] = useState<RunView>();
  const [error, setError] = useState<ReturnType<typeof routineError>>();
  const [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry starts a fresh polling lifetime after failure.
  useEffect(() => {
    const owner = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;
    setRun(undefined);
    setError(undefined);
    running(true);
    const read = async () => {
      if (pending || owner.signal.aborted) return;
      pending = true;
      clearTimeout(timer);
      try {
        const result = await waitRpc(
          () => {
            if (!peer) throw new Error("Disconnected");
            return peer.call("routines.trialResult", { runId: id });
          },
          AbortSignal.any([owner.signal, AbortSignal.timeout(30_000)]),
        );
        if (owner.signal.aborted) return;
        if (
          result.id !== id ||
          result.botId !== botId ||
          result.reason !== "trial" ||
          result.routineId !== null
        )
          throw new Error("Trial ownership mismatch");
        setRun(result);
        setError(undefined);
        running(activeRun(result));
        if (activeRun(result)) timer = setTimeout(() => void read(), 1500);
      } catch (e) {
        if (!owner.signal.aborted) {
          setError(peer ? routineError(e) : "routines.unavailable");
        }
      } finally {
        pending = false;
      }
    };
    const off = peer?.on("routine.run", (event) => {
      if (event.routineRunId === id && event.botId === botId) void read();
    });
    void read();
    return () => {
      owner.abort();
      clearTimeout(timer);
      off?.();
    };
  }, [peer, id, botId, running, revision]);
  const ops = run ? [...new Map(run.allowedOps.map((op) => [operationKey(op), op])).values()] : [];
  return (
    <section className={`${styles.stack} ${styles.formCard}`} data-mark="orange">
      <h2>{t("routines.trialOps")}</h2>
      <p className={styles.note}>{t("routines.trialNote")}</p>
      {!current && (
        <p role="alert" className={styles.warn}>
          {t("routines.trialChanged")}
        </p>
      )}
      {imageReferencesUnsupported && (
        <p role="alert" className={styles.warn}>
          {t("media.routineReferencesUnsupported")}
        </p>
      )}
      {run ? (
        <div className={styles.runCard}>
          <RunRow run={run} />
          {ops.length ? (
            <ul className={styles.opList}>
              {ops.map((op) => (
                <li key={operationKey(op)} className={styles.opChip}>
                  {t(`permissions.category.${op.category}`)} · {operationText(op, t)}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.note}>{t("routines.none")}</p>
          )}
          {ops.length > 0 && (
            <Button
              variant="secondary"
              disabled={
                disabled || !current || imageReferencesUnsupported || activeRun(run) || !!error
              }
              onClick={() => remember(ops)}
            >
              {t("routines.addAllowed")}
            </Button>
          )}
        </div>
      ) : (
        !error && (
          <p role="status" className={styles.note}>
            {t("common.loading")}
          </p>
        )
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {t(error)} <Button onClick={() => setRevision((n) => n + 1)}>{t("common.retry")}</Button>
        </p>
      )}
    </section>
  );
}
