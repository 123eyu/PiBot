import type { ContinuationResumeResult } from "@pibot/protocol";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useAction, useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useState } from "react";
import { usePendingContinuations } from "../../app/continuations.ts";
import styles from "./continuation-prompt.module.css";

/**
 * Automatic continuations an earlier process left unfinished never resume by
 * themselves. This topic-level bar is the only way back: Continue asks the brain to re-check every
 * chain against the current source, plan and permissions; Discard drops them.
 */
export function ContinuationPrompt({ conversationId }: { conversationId: string | undefined }) {
  const t = useT();
  const { peer } = useRpc();
  const task = useAction();
  const count = usePendingContinuations(conversationId);
  // The outcome of the last Continue, shown even after the bar's count reaches zero.
  const [outcome, setOutcome] = useState<{ id: string; result: ContinuationResumeResult }>();
  const shown = outcome && outcome.id === conversationId ? outcome.result : undefined;
  const notes = [
    shown?.dropped ? t("runtime.continuationDropped", { count: shown.dropped }) : "",
    shown?.kept ? t("runtime.continuationKept", { count: shown.kept }) : "",
    shown?.busy ? t("runtime.continuationBusy") : "",
  ].filter(Boolean);
  if (!conversationId || (!count && !notes.length)) return null;
  const failure = (error: unknown) =>
    error instanceof RpcError && error.code === RpcErrorCodes.busy
      ? "runtime.continuationBusy"
      : "runtime.continuationFailed";
  return (
    <div role="status" className={styles.bar}>
      {count > 0 && (
        <>
          <span>{t("runtime.continuationPrompt")}</span>
          <span className={styles.actions}>
            <Button
              variant="secondary"
              disabled={!peer || task.busy}
              onClick={() => {
                if (!peer) return;
                setOutcome(undefined);
                void task.run(
                  (signal) => peer.call("continuations.discard", { conversationId }, { signal }),
                  failure,
                );
              }}
            >
              {t("runtime.continuationDiscard")}
            </Button>
            <Button
              disabled={!peer || task.busy}
              loading={task.busy}
              onClick={() => {
                if (!peer) return;
                void task
                  .run(
                    (signal) =>
                      peer.call(
                        "continuations.resume",
                        { conversationId, confirmed: true },
                        { signal },
                      ),
                    failure,
                  )
                  .then((result) => {
                    if (result) setOutcome({ id: conversationId, result });
                  });
              }}
            >
              {t("runtime.continuationResume")}
            </Button>
          </span>
        </>
      )}
      {notes.map((note) => (
        <span key={note} className={styles.note}>
          {note}
        </span>
      ))}
      {task.error && (
        <span role="alert" className={styles.note}>
          {t(task.error)}
        </span>
      )}
    </div>
  );
}
