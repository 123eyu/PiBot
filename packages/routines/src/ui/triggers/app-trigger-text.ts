import type { RoutineDraft } from "@pibot/protocol";
import type { useSettings } from "@pibot/renderer-kit";

type Trigger = RoutineDraft["triggers"][number];
type T = ReturnType<typeof useSettings>["t"];

/** One-line summary of a connection, calendar or retired GitHub trigger for lists and cards. */
export function appTriggerText(config: Trigger, t: T): string | undefined {
  if (config.kind === "connection")
    return `${t("routines.connection")} · ${t(`routines.check.${config.check}`)}`;
  if (config.kind === "calendar")
    return `${t("routines.calendar")} · ${
      config.event === "before_start"
        ? t("routines.calendar.beforeSummary", { minutes: config.minutesBefore })
        : t("routines.calendar.event.new_event")
    }`;
  if (config.kind === "github") return `${t("routines.github")} · ${config.repository}`;
  return undefined;
}

/** Triggers that fire on something happening, so "no next time" is not "nothing planned". */
export const watchesEvents = (config: { kind: string }) =>
  config.kind === "folder" || config.kind === "connection" || config.kind === "calendar";

export const hasRetiredTrigger = (triggers: readonly { kind: string }[]) =>
  triggers.some((trigger) => trigger.kind === "github");
