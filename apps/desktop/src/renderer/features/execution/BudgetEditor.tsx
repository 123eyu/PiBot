import {
  DEFAULT_EXECUTION_LIMITS,
  type ExecutionLimits,
  type ExecutionSettings,
} from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Icon, IconTile } from "@pibot/ui";
import { useEffect, useId, useRef, useState } from "react";
import {
  budgetRange,
  budgetValues,
  budgetFields as fields,
  parseBudgetValues,
} from "./budget-values.ts";
import styles from "./execution.module.css";

const costText = (limits: ExecutionLimits) =>
  limits.costUsd === null ? "" : String(limits.costUsd);
const same = (a: ExecutionLimits, b: ExecutionLimits) =>
  (Object.keys(a) as (keyof ExecutionLimits)[]).every((key) => a[key] === b[key]);

/**
 * Next-run limits of a topic or group. Maintainers 2026-11-13: no save button — a field saves when it
 * is left or Enter is pressed, 恢复默认 applies at once. The parent keeps this mounted across
 * versions so the panel does not fold up after every save.
 */
export function BudgetEditor({
  settings,
  accept,
  persist,
  hint,
}: {
  settings: ExecutionSettings;
  accept(value: ExecutionSettings): void;
  persist?(limits: ExecutionLimits, signal: AbortSignal): Promise<ExecutionSettings>;
  hint?: string;
}) {
  const { peer } = useRpc(),
    t = useT(),
    id = useId();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(() => budgetValues(settings.limits)),
    [cost, setCost] = useState(() => costText(settings.limits));
  const [saving, setSaving] = useState(false),
    [error, setError] = useState(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const body = useRef<HTMLDivElement>(null);
  const latest = useRef(settings);
  latest.current = settings;
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  // A newer version (this panel's own save, another window, the task pane) refreshes the fields
  // unless the user is typing in one of them.
  useEffect(() => {
    if (body.current?.contains(document.activeElement)) return;
    setValues(budgetValues(settings.limits));
    setCost(costText(settings.limits));
  }, [settings.limits]);
  const parsed = parseBudgetValues(values, cost);
  const invalid = new Set(parsed.success ? [] : parsed.error.issues.map((issue) => issue.path[0]));
  const save = async (limits: ExecutionLimits) => {
    const signal = lifetime.current?.signal;
    const current = latest.current;
    if (!peer || !signal || signal.aborted || saving || same(limits, current.limits)) return;
    setSaving(true);
    setError(false);
    try {
      const next = persist
        ? await persist(limits, signal)
        : await peer.call(
            "execution.set",
            {
              botId: current.botId,
              conversationId: current.conversationId,
              expectedVersion: current.version,
              mode: current.mode,
              limits,
            },
            { signal, timeoutMs: 10_000 },
          );
      if (!signal.aborted) accept(next);
    } catch {
      if (!signal.aborted) setError(true);
    } finally {
      if (!signal.aborted) setSaving(false);
    }
  };
  const commit = () => {
    if (parsed.success) void save(parsed.data);
  };
  const field = (
    key: string,
    label: string,
    input: React.InputHTMLAttributes<HTMLInputElement>,
    problem?: string,
  ) => (
    <label className={styles.budgetRow} key={key}>
      <span>{label}</span>
      <input
        type="number"
        inputMode="decimal"
        disabled={saving}
        aria-invalid={invalid.has(key)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        {...input}
      />
      {invalid.has(key) && problem && <small role="alert">{problem}</small>}
    </label>
  );
  return (
    <section className={styles.budgetEditor}>
      <button
        type="button"
        className={styles.budgetHead}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <IconTile icon="clock" tone="violet" size="sm" />
        <span>{t("execution.nextBudget")}</span>
        <Icon name="chevronRight" size={14} className={styles.budgetChevron} />
      </button>
      {open && (
        <div id={id} ref={body} className={styles.budgetCard}>
          <p className={styles.hint}>{hint ?? t("execution.budgetHint")}</p>
          <div className={styles.budgetRows}>
            {fields.map((key) =>
              field(
                key,
                t(key === "activeSeconds" ? "agentWork.minutes" : `execution.limit.${key}`),
                {
                  value: values[key],
                  step: key === "activeSeconds" ? "any" : "1",
                  min: budgetRange(key).min,
                  max: budgetRange(key).max,
                  onChange: (event) => {
                    const value = event.currentTarget.value;
                    setValues((current) => ({ ...current, [key]: value }));
                  },
                },
                t("agentWork.invalidRange", budgetRange(key)),
              ),
            )}
            {field(
              "costUsd",
              t("execution.limit.costUsd"),
              {
                value: cost,
                min: "0",
                max: "10000",
                step: "any",
                placeholder: t("execution.noCostCap"),
                onChange: (event) => setCost(event.currentTarget.value),
              },
              t("agentWork.invalidField"),
            )}
          </div>
          <p className={styles.hint}>{t("execution.priceUnknownHint")}</p>
          {error && (
            <p role="alert" className={styles.error}>
              {t("execution.conflict")}
            </p>
          )}
          <div className={styles.budgetFoot}>
            <button
              type="button"
              className={styles.budgetReset}
              disabled={saving}
              onClick={() => {
                setValues(budgetValues(DEFAULT_EXECUTION_LIMITS));
                setCost(costText(DEFAULT_EXECUTION_LIMITS));
                void save(DEFAULT_EXECUTION_LIMITS);
              }}
            >
              <Icon name="undo" size={13} />
              {t("agentWork.defaults")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
