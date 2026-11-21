import type { Message, UserQuestionPauseSchema } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import cards from "./chat-cards.module.css";
import styles from "./execution.module.css";
import { userQuestionError } from "./user-question-error.ts";

type Pause = ReturnType<typeof UserQuestionPauseSchema.parse>;
export function UserQuestionCard({
  message,
  pause,
  inbox = false,
}: {
  message: Message;
  pause: Pause;
  inbox?: boolean;
}) {
  const { peer } = useRpc(),
    t = useT();
  const [selected, setSelected] = useState<string>();
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof userQuestionError>>();
  const [answer, setAnswer] = useState<string>();
  const [dismissed, setDismissed] = useState(false);
  const pending = useRef(false),
    lifetime = useRef<AbortController | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A different message owns a separate draft and request lifetime.
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setSelected(undefined);
    setCustom("");
    setBusy(false);
    setError(undefined);
    setAnswer(undefined);
    setDismissed(false);
    pending.current = false;
    return () => controller.abort();
  }, [message.id, peer]);
  const question = pause.fixedOptions
    ? {
        ...pause.question,
        prompt: t("group.plan.limit.question"),
        options: pause.question.options.map((option) =>
          option.id === "extend" || option.id === "solo" || option.id === "end"
            ? {
                ...option,
                label: t(`group.plan.limit.${option.id}`),
                description: t(`group.plan.limit.${option.id}Hint`),
              }
            : option,
        ),
      }
    : pause.question;
  const answered = pause.answer?.text ?? answer;
  const oldQuestion =
    inbox && !pause.fixedOptions && Date.now() - Date.parse(message.createdAt) > 3 * 86_400_000;
  const permissionRelated = question.options.some((option) =>
    /权限|授权|审批|允许(?:一次|本次|始终|以后|访问|读取|写入|执行|操作)|\b(?:permissions?|authori[sz](?:e|ation)|approv(?:e|al)|grant(?:ing)?\s+access|allow\s+(?:access|once|always))\b/iu.test(
      `${option.label} ${option.description}`,
    ),
  );
  // The chat gets the lively card; the inbox keeps its own page look.
  const lively = (name: keyof typeof cards) => (inbox ? "" : (cards[name] ?? ""));
  if (answered)
    return (
      <section className={`${styles.questionCard} ${lively("answered")}`} role="status">
        <strong>{question.prompt}</strong>
        <p>
          {dismissed
            ? t("workspace.inboxDismissed")
            : t("execution.questionAnswered", { answer: answered })}
        </p>
      </section>
    );
  const submit = async (dismiss = false) => {
    const signal = lifetime.current?.signal;
    if (
      !peer ||
      !signal ||
      signal.aborted ||
      pending.current ||
      (!dismiss && !selected) ||
      message.status !== "done"
    )
      return;
    const option = question.options.find((option) => option.id === selected);
    if (!dismiss && !option && selected !== "custom") return;
    if (!dismiss && !option && !custom.trim()) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (dismiss)
        await peer.call(
          "execution.question.dismiss",
          { messageId: message.id },
          { signal, timeoutMs: 35000 },
        );
      else
        await peer.call(
          "execution.question.answer",
          {
            messageId: message.id,
            reply: option ? { optionId: option.id } : { custom: custom.trim() },
          },
          { signal, timeoutMs: pause.fixedOptions ? 95000 : 35000 },
        );
      if (!signal.aborted) {
        setDismissed(dismiss);
        setAnswer(dismiss ? "不用继续了" : (option?.label ?? custom.trim()));
      }
    } catch (error) {
      if (!signal.aborted) setError(userQuestionError(error));
    } finally {
      if (!signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section
      className={`${styles.questionCard} ${lively("question")}`}
      aria-label={t("execution.questionTitle")}
    >
      {!inbox && (
        <div className={cards.questionHead} aria-hidden="true">
          <IconTile icon="star" tone="violet" size="lg" />
          <span>
            <b>{t("execution.questionTitle")}</b>
            <small>{t("execution.questionChoose")}</small>
          </span>
        </div>
      )}
      <div className={inbox ? cards.contents : cards.questionBody}>
        <strong>{question.prompt}</strong>
        <fieldset disabled={busy || message.status !== "done"}>
          <legend className={inbox ? styles.questionLegend : cards.visuallyHidden}>
            {t("execution.questionChoose")}
          </legend>
          {question.options.map((option) => (
            <label key={option.id} className={`${styles.questionOption} ${lively("option")}`}>
              <input
                type="radio"
                name={`question-${message.id}`}
                value={option.id}
                checked={selected === option.id}
                onChange={() => setSelected(option.id)}
              />
              <span className={styles.questionText}>
                <b>{option.label}</b>
                {!pause.fixedOptions && option.id === pause.question.recommendedId && (
                  <small className={`${styles.recommended} ${lively("recommended")}`}>
                    {t("execution.questionRecommended")}
                  </small>
                )}
                <span className={styles.questionImpact}>{option.description}</span>
              </span>
            </label>
          ))}
          {!pause.fixedOptions && (
            <>
              <label className={`${styles.questionOption} ${lively("option")}`}>
                <input
                  type="radio"
                  name={`question-${message.id}`}
                  checked={selected === "custom"}
                  onChange={() => setSelected("custom")}
                />
                <span>{t("execution.questionCustom")}</span>
              </label>
              <textarea
                aria-label={t("execution.questionCustom")}
                maxLength={2000}
                rows={2}
                value={custom}
                onFocus={() => setSelected("custom")}
                onChange={(event) => {
                  setCustom(event.currentTarget.value);
                  setSelected("custom");
                }}
              />
            </>
          )}
        </fieldset>
        {permissionRelated && (
          <p className={styles.hint}>{t("execution.questionPermissionNote")}</p>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {t(error)}
          </p>
        )}
        {oldQuestion && (
          <Button
            variant="ghost"
            disabled={!peer || busy || message.status !== "done"}
            onClick={() => void submit(true)}
          >
            {t("workspace.inboxDismissQuestion")}
          </Button>
        )}
        <Button
          variant="secondary"
          className={lively("go")}
          disabled={
            !peer ||
            busy ||
            !selected ||
            (selected === "custom" && !custom.trim()) ||
            message.status !== "done"
          }
          onClick={() => void submit()}
        >
          {t("execution.questionContinue")}
        </Button>
      </div>
    </section>
  );
}
