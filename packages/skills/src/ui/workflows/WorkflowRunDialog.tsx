import { useRpc, useSettings, useT } from "@pibot/renderer-kit";
import type {
  WorkflowBinding,
  WorkflowEstimate,
  WorkflowPrecheckFailure,
  WorkflowSummary,
} from "@pibot/skills-contract/full";
import { RpcError } from "@pibot/skills-contract/full";
import { Button, IconTile } from "@pibot/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { workflowDefaults } from "./state.ts";
import { WorkflowFields } from "./WorkflowFields.tsx";
import styles from "./workflow.module.css";

export interface WorkflowTarget {
  botId: string;
  botName: string;
  groupId?: string;
  conversationId?: string;
}

interface Choice {
  target: WorkflowTarget;
  workflow: WorkflowSummary;
}

/** The note is stored as `中文 / English` (WorkflowVerificationSchema); show the UI language's half. */
const verificationTitle = (workflow: WorkflowSummary, language: string) => {
  if (!workflow.verified) return undefined;
  const { date, note } = workflow.verified;
  const split = note.indexOf(" / ");
  const text = split < 0 ? note : language === "zh" ? note.slice(0, split) : note.slice(split + 3);
  return `${date} · ${text}`;
};

/**
 * Runs one saved plan (「常用计划」). Users never pick a workflow, so the dialog
 * only fills that plan's inputs, cost cap and ambiguous owners.
 */
export function WorkflowRunDialog({
  targets,
  skillId,
  close,
}: {
  targets: readonly WorkflowTarget[];
  skillId: string;
  close(): void;
}) {
  const t = useT();
  const { language } = useSettings();
  const { peer } = useRpc();
  const title = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [binding, setBinding] = useState<WorkflowBinding>();
  const [failures, setFailures] = useState<WorkflowPrecheckFailure[]>([]);
  const [runError, setRunError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [ownerRequirements, setOwnerRequirements] = useState<
    { role: string; candidates: { botId: string; name: string }[] }[]
  >([]);
  const [ownerOverrides, setOwnerOverrides] = useState<Record<string, string>>({});
  const [estimate, setEstimate] = useState<WorkflowEstimate>();
  const [cap, setCap] = useState("");
  const runAbort = useRef<AbortController | undefined>(undefined);
  const closeRef = useRef(close);
  closeRef.current = close;
  const targetKey = JSON.stringify(targets);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || runAbort.current) return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      runAbort.current?.abort();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: targetKey is the stable target identity.
  useEffect(() => {
    if (!peer) {
      setLoading(false);
      setLoadError(true);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setLoadError(false);
    void Promise.all(
      targets.map(async (target) => ({
        target,
        items: (
          await peer.call(
            "skills.workflows",
            { botId: target.botId, groupId: target.groupId },
            { signal: abort.signal },
          )
        ).items,
      })),
    )
      .then((groups) => {
        if (abort.signal.aborted) return;
        const next = groups.flatMap(({ target, items }) =>
          items
            .filter(
              (workflow) => workflow.skillId === skillId && workflow.enabled && workflow.contract,
            )
            .map((workflow) => ({ target, workflow })),
        );
        setChoices(next);
        const first = next[0];
        if (first) setBinding(workflowDefaults(first.workflow));
        setLoading(false);
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setLoading(false);
          setLoadError(true);
        }
      });
    return () => abort.abort();
  }, [peer, targetKey, skillId]);

  const choice = choices[0];
  const contractCap = choice?.workflow.contract?.budget?.costUsd;
  const estimateKey = choice ? `${choice.target.botId}:${choice.workflow.skillId}` : "";
  // The estimate is read again for each chosen workflow; it only informs, never blocks.
  // biome-ignore lint/correctness/useExhaustiveDependencies: estimateKey is the choice identity.
  useEffect(() => {
    setEstimate(undefined);
    setCap(contractCap === undefined ? "" : String(contractCap));
    if (!peer || !choice) return;
    const abort = new AbortController();
    peer
      .call(
        "skills.workflowEstimate",
        {
          botId: choice.target.botId,
          groupId: choice.target.groupId,
          skillId: choice.workflow.skillId,
        },
        { signal: abort.signal },
      )
      .then((value) => {
        if (!abort.signal.aborted) setEstimate(value);
      })
      // Without an estimate the form still shows the contract cap.
      .catch(() => undefined);
    return () => abort.abort();
  }, [peer, estimateKey]);
  const capValue = cap.trim() === "" ? undefined : Number(cap);
  const capInvalid =
    (contractCap !== undefined && capValue === undefined) ||
    (capValue !== undefined &&
      (!Number.isFinite(capValue) || capValue <= 0 || capValue > (contractCap ?? 10_000)));
  const failureNames = useMemo(
    () => new Map(choice?.workflow.contract?.inputs.map((input) => [input.name, input.name]) ?? []),
    [choice],
  );
  const submit = async () => {
    if (!peer || !choice || !binding || running || capInvalid) return;
    const abort = new AbortController();
    runAbort.current = abort;
    setRunning(true);
    setFailures([]);
    setRunError(undefined);
    try {
      const result = await peer.call(
        "skills.runWorkflow",
        {
          botId: choice.target.botId,
          groupId: choice.target.groupId,
          conversationId: choice.target.conversationId,
          skillId: binding.skillId,
          params: binding.params,
          inputs: binding.inputs,
          // The server rechecks this cap against the declared contract and group limits.
          ...(capValue !== undefined ? { costCapUsd: capValue } : {}),
          ...(ownerRequirements.length ? { ownerOverrides } : {}),
        },
        { signal: abort.signal, timeoutMs: 30_000 },
      );
      if (abort.signal.aborted) return;
      if (result.status === "blocked") setFailures(result.failures);
      else if (result.status === "owners_required") {
        setOwnerRequirements(result.roles);
        // Ambiguous ownership is an authorization choice. Never select a member on the user's
        // behalf; the submit button remains disabled until every role was explicitly chosen.
        setOwnerOverrides({});
      } else close();
    } catch (error) {
      if (!abort.signal.aborted)
        setRunError(error instanceof RpcError ? error.message : "workflow_failed");
    } finally {
      if (!abort.signal.aborted) setRunning(false);
      if (runAbort.current === abort) runAbort.current = undefined;
    }
  };
  const errorText = (error: string) => {
    if (
      error === "workflow_not_contract" ||
      error === "workflow_contract_invalid" ||
      error === "workflow_budget_above_contract"
    )
      return t(`workflows.error.${error}`);
    if (error === "no_model") return t("chat.noModel");
    return t("workflows.runError");
  };
  return (
    <div className={styles.overlay}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={title}>
        <h2 id={title} className={styles.title}>
          <IconTile icon="play" tone="violet" size="lg" />
          {t("workflows.run.title")}
        </h2>
        {loading && <p role="status">{t("common.loading")}</p>}
        {loadError && (
          <p role="alert" className={styles.error}>
            {t("workflows.loadError")}
          </p>
        )}
        {!loading && !loadError && !choices.length && <p>{t("workflows.none")}</p>}
        {!!choices.length && choice && binding && (
          <>
            <p className={styles.field}>
              <strong>{choice.workflow.name}</strong>
              {choice.workflow.verified && (
                <span
                  className={styles.verifiedBadge}
                  title={verificationTitle(choice.workflow, language)}
                >
                  {t("workflows.verified")}
                </span>
              )}
            </p>
            <WorkflowFields
              botId={choice.target.botId}
              groupId={choice.target.groupId}
              workflow={choice.workflow}
              value={binding}
              disabled={running}
              change={setBinding}
            />
            <WorkflowCost
              estimate={estimate}
              contractCap={contractCap}
              cap={cap}
              invalid={capInvalid}
              disabled={running}
              change={setCap}
            />
            {ownerRequirements.map((requirement) => (
              <label className={styles.field} key={requirement.role}>
                <span>{t("workflows.ownerRequired", { role: requirement.role })}</span>
                <select
                  value={ownerOverrides[requirement.role] ?? ""}
                  disabled={running}
                  onChange={(event) =>
                    setOwnerOverrides((current) => ({
                      ...current,
                      [requirement.role]: event.currentTarget.value,
                    }))
                  }
                >
                  <option value="" disabled>
                    {t("workflows.ownerChoose")}
                  </option>
                  {requirement.candidates.map((candidate) => (
                    <option key={candidate.botId} value={candidate.botId}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </>
        )}
        {!!failures.length && (
          <div className={styles.blocked} role="alert">
            <strong>{t("workflows.precheck.title")}</strong>
            <ul>
              {failures.map((failure) => (
                <li key={`${failure.input}:${failure.reason}`}>
                  {t(`workflows.precheck.${failure.reason}`, {
                    input: failureNames.get(failure.input) ?? failure.input,
                  })}
                </li>
              ))}
            </ul>
          </div>
        )}
        {runError && (
          <p role="alert" className={styles.error}>
            {errorText(runError)}
          </p>
        )}
        <div className={styles.actions}>
          <Button ref={cancel} type="button" variant="ghost" disabled={running} onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            className={styles.run}
            loading={running}
            disabled={
              !choice ||
              !binding ||
              loading ||
              loadError ||
              capInvalid ||
              ownerRequirements.some((requirement) => !ownerOverrides[requirement.role])
            }
            onClick={() => void submit()}
          >
            {t("workflows.run")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function usd(value: number) {
  return value > 0 && value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
}

/**
 * 「预计约 $0.30（最近 5 次中位数）· 上限 $1」 and this run's cap. The cap may only go down;
 * the brain refuses a higher one (`workflow_budget_above_contract`).
 */
function WorkflowCost({
  estimate,
  contractCap,
  cap,
  invalid,
  disabled,
  change,
}: {
  estimate: WorkflowEstimate | undefined;
  contractCap: number | undefined;
  cap: string;
  invalid: boolean;
  disabled: boolean;
  change(value: string): void;
}) {
  const t = useT();
  const hint = useId();
  const line =
    estimate?.estimateUsd != null
      ? [
          t("workflows.estimate.median", {
            cost: usd(estimate.estimateUsd),
            count: estimate.samples,
          }),
          ...(contractCap !== undefined
            ? [t("workflows.estimate.cap", { cap: usd(contractCap) })]
            : []),
        ].join(" · ")
      : contractCap !== undefined
        ? t("workflows.estimate.capOnly", { cap: usd(contractCap) })
        : estimate
          ? t("workflows.estimate.none")
          : "";
  return (
    <>
      {line && (
        <p className={`${styles.note} ${styles.estimate}`}>
          <IconTile icon="chart" tone="green" size="sm" />
          {line}
        </p>
      )}
      <label className={styles.field}>
        <span>{t("workflows.cap.label")}</span>
        <input
          type="text"
          inputMode="decimal"
          value={cap}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={hint}
          onChange={(event) => change(event.currentTarget.value)}
        />
        <small id={hint} className={invalid ? styles.warn : undefined}>
          {invalid
            ? t("workflows.cap.invalid", { cap: usd(contractCap ?? 10_000) })
            : contractCap === undefined
              ? t("workflows.cap.optional")
              : t("workflows.cap.hint", { cap: usd(contractCap) })}
        </small>
      </label>
    </>
  );
}
