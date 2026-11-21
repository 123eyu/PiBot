import type { Routine, RoutineDraft, RoutineProposal } from "@pibot/protocol";
import { type Peer, useRpc, useSettings } from "@pibot/renderer-kit";
import { Button, Card } from "@pibot/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { RoutineEditor, routineDraft } from "../editor/RoutineEditor.tsx";
import { operationText } from "../preauth/preauth.ts";
import { useRemote, useRoutineAction } from "../shell/remote.ts";
import styles from "../shell/routines.module.css";
import { appTriggerText } from "../triggers/app-trigger-text.ts";
import { cronText } from "../triggers/cron.ts";
import { onceText } from "../triggers/once.ts";
import { useProposalRefresh } from "./proposal-refresh.ts";

const fields = [
  "botId",
  "name",
  "instructions",
  "triggers",
  "workplace",
  "preauth",
  "notify",
  "maxDurationMin",
  "carryLastResult",
  "output",
  "missedPolicy",
  "enabled",
] as const;
export function RoutineProposalCard({
  proposal,
  resolved,
}: {
  proposal: RoutineProposal;
  resolved?(value: RoutineProposal): void;
}) {
  const { peer } = useRpc();
  const { t, language } = useSettings();
  const action = useRoutineAction();
  const [current, setCurrent] = useState(proposal);
  const [base, setBase] = useState<Routine>();
  const [edited, setEdited] = useState<RoutineDraft>();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState(false);
  const load = useCallback(
    async (peer: Peer) => {
      const list = await peer.call("routines.proposals", { id: proposal.id });
      const p = list[0];
      if (
        !p ||
        p.id !== proposal.id ||
        p.botId !== proposal.botId ||
        p.messageId !== proposal.messageId
      )
        throw new Error("Proposal owner changed");
      const routine =
        p.status === "open" && p.payload.routineId
          ? await peer.call("routines.get", { id: p.payload.routineId })
          : undefined;
      if (
        routine &&
        (routine.id !== p.payload.routineId ||
          routine.botId !== p.botId ||
          routine.version !== p.payload.expectedVersion ||
          routine.deletedAt)
      )
        throw new Error("Proposal is stale");
      return { proposal: p, routine };
    },
    [proposal.id, proposal.botId, proposal.messageId],
  );
  const onResolved = useRef(resolved);
  onResolved.current = resolved;
  const remote = useRemote(load);
  useProposalRefresh(remote.refresh, {
    botId: proposal.botId,
    messageId: proposal.messageId,
    proposalId: proposal.id,
    routineId: proposal.payload.routineId,
    enabled: current.status === "open",
  });
  useEffect(() => {
    if (!remote.value) return;
    setCurrent(remote.value.proposal);
    if (remote.value.routine) setBase((old) => old ?? remote.value?.routine);
    if (remote.value.proposal.status !== "open") onResolved.current?.(remote.value.proposal);
  }, [remote.value]);
  const finish = async (accept: boolean, draft?: RoutineDraft) => {
    if (!peer) return;
    if (
      accept &&
      current.payload.missingFields.some(
        (field) => !fields.includes(field as (typeof fields)[number]) && !answers[field]?.trim(),
      )
    ) {
      setMissing(true);
      return;
    }
    const result = await action.run(() =>
      peer.call("routines.proposal.resolve", {
        proposalId: current.id,
        accept,
        ...(draft ? { edits: draft } : {}),
        answers,
      }),
    );
    if (result && result.proposal.id === current.id && result.proposal.botId === current.botId) {
      setCurrent(result.proposal);
      resolved?.(result.proposal);
      remote.refresh();
    }
  };
  const draft = {
    ...(base ? routineDraft(base) : {}),
    botId: current.botId,
    ...current.payload.draft,
    ...(current.status === "accepted" ? current.payload.acceptedDraft : {}),
  };
  const stale =
    !!current.payload.routineId && (!base || base.version !== current.payload.expectedVersion);
  const disabled = action.disabled || remote.loading || !!remote.error || stale;
  return (
    <Card className={styles.stack}>
      <h2>{t(current.payload.routineId ? "routineProposal.update" : "routineProposal.create")}</h2>
      <strong>{draft.name ?? t("routineProposal.untitled")}</strong>
      {draft.triggers?.map((trigger) => (
        <p key={JSON.stringify(trigger)} className={styles.note}>
          {trigger.kind === "cron"
            ? cronText(trigger.expr, trigger.timezone, language)
            : trigger.kind === "once"
              ? `${t("routines.once")} · ${onceText(trigger.at, trigger.timezone, language)}`
              : trigger.kind === "folder"
                ? trigger.path
                : appTriggerText(trigger, t)}
        </p>
      ))}
      {current.status !== "open" ? (
        <p role="status">{t(`routineProposal.${current.status}`)}</p>
      ) : (
        <>
          <p className={styles.note}>{t("routineProposal.note")}</p>
          {current.payload.questions?.map((question) => (
            <p key={question} role="alert" className={styles.warn}>
              {question}
            </p>
          ))}
          {current.payload.missingFields.length > 0 && (
            <section className={styles.stack}>
              <h3>{t("routineProposal.required")}</h3>
              {current.payload.missingFields.map((field) =>
                fields.includes(field as (typeof fields)[number]) ? (
                  <p key={field} className={styles.note}>
                    {t(`routineProposal.field.${field as (typeof fields)[number]}`)}
                  </p>
                ) : (
                  <label key={field} className={styles.field}>
                    {field}
                    <input
                      required
                      maxLength={1000}
                      value={answers[field] ?? ""}
                      disabled={disabled}
                      onChange={(e) => {
                        setAnswers((old) => ({ ...old, [field]: e.currentTarget.value }));
                        setMissing(false);
                      }}
                    />
                  </label>
                ),
              )}
            </section>
          )}
          {base && (
            <details>
              <summary>{t("routineProposal.changes")}</summary>
              <dl>
                {fields
                  .filter(
                    (field) =>
                      (edited ?? current.payload.draft)[field] !== undefined &&
                      JSON.stringify(routineDraft(base)[field]) !==
                        JSON.stringify((edited ?? current.payload.draft)[field]),
                  )
                  .map((field) => (
                    <div key={field}>
                      <dt>{t(`routineProposal.field.${field}`)}</dt>
                      <dd>
                        {JSON.stringify(routineDraft(base)[field])} →{" "}
                        {JSON.stringify((edited ?? current.payload.draft)[field])}
                      </dd>
                    </div>
                  ))}
              </dl>
            </details>
          )}
          {current.payload.blockedPreauth.map(({ operation }) => (
            <label className={styles.warn} key={JSON.stringify(operation)}>
              <input type="checkbox" checked={false} disabled readOnly />{" "}
              {operationText(operation, t)} · {t("routineProposal.blocked")}
            </label>
          ))}
          {(!current.payload.routineId || base) && (
            <RoutineEditor
              initial={draft}
              onceRequest={current.payload.onceRequest}
              saved={base}
              onDraftChange={setEdited}
              disabled={disabled}
              submitLabel={t(
                current.payload.routineId ? "routineProposal.save" : "routineProposal.build",
              )}
              onSubmit={(draft) => finish(true, draft)}
            />
          )}
          <Button variant="secondary" disabled={action.disabled} onClick={() => void finish(false)}>
            {t("routineProposal.decline")}
          </Button>
        </>
      )}
      {remote.loading && <p role="status">{t("common.loading")}</p>}
      {remote.error && (
        <p className={styles.error} role="alert">
          {t("routineProposal.stale")} <Button onClick={remote.refresh}>{t("common.retry")}</Button>
        </p>
      )}
      {action.error && (
        <p className={styles.error} role="alert">
          {t(action.error)}
        </p>
      )}
      {missing && (
        <p className={styles.error} role="alert">
          {t("routineProposal.fill")}
        </p>
      )}
    </Card>
  );
}
