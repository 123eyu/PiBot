import type { createTranslator } from "@pibot/i18n";
import { type Message, messageVisibleText } from "@pibot/protocol";

type Translate = ReturnType<typeof createTranslator>;
type RoutineTrigger = NonNullable<Message["routineTrigger"]>;

const SHOWN = 3;

/** A few names, then "and N in all": a long list would turn the bubble into the raw data again. */
function some(names: readonly string[], total: number, t: Translate) {
  const listed = names.slice(0, SHOWN);
  const shown = listed.join(t("routines.triggerMessage.separator"));
  const count = Math.max(total, names.length);
  return count > listed.length ? t("routines.triggerMessage.more", { shown, count }) : shown;
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/**
 * The routine topic's first message as the person sees it. Its stored content is written for the
 * model (bilingual headers, BEGIN_UNTRUSTED_… markers, raw JSON), so the bubble is rebuilt from
 * the trigger's structured fields; the content itself only ever goes to the model.
 */
export function routineTriggerText(trigger: RoutineTrigger, t: Translate) {
  if (trigger.connection) {
    const { connectorName, check, changed } = trigger.connection;
    return t("routines.triggerMessage.connection", {
      connector: connectorName,
      count: changed,
      check: t(`routines.check.${check}`),
    });
  }
  if (trigger.calendar) {
    const { event, events, total } = trigger.calendar;
    const titles = some(
      events.map((entry) => entry.title),
      total,
      t,
    );
    return t(
      event === "before_start"
        ? "routines.triggerMessage.calendarStart"
        : "routines.triggerMessage.calendarNew",
      { count: total, titles },
    );
  }
  if (trigger.github)
    return t("routines.triggerMessage.github", {
      repository: trigger.github.repository,
      count: trigger.github.total,
    });
  const changes = trigger.paths.length + trigger.extraCount;
  if (changes)
    return t("routines.triggerMessage.folder", {
      count: changes,
      names: some(trigger.paths.map(baseName), changes, t),
    });
  return t("routines.triggerMessage.started", {
    reason: t(`routines.reason.${trigger.reason}`),
  });
}

/** What copy, quote and selection take from a message: the text its bubble shows. */
export function messageShownText(
  message: Pick<Message, "content" | "usage" | "routineTrigger">,
  t: Translate,
) {
  return message.routineTrigger
    ? routineTriggerText(message.routineTrigger, t)
    : messageVisibleText(message);
}
