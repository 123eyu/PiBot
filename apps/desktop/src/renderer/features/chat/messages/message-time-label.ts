import type { Language, TranslationVars } from "@pibot/i18n";

/** Kept free of renderer-kit so the cached startup screen can draw the same separators. */
export function messageTimeLabel({
  at,
  previousAt,
  firstTopicMessage,
  today,
  language,
  t,
}: {
  at: string;
  previousAt?: string;
  firstTopicMessage: boolean;
  today: string;
  language: Language;
  // Only these keys: the cached startup screen passes its small label table, not the full one.
  t(key: "workspace.messageToday" | "workspace.newTopic", vars?: TranslationVars): string;
}): string | null {
  const date = new Date(at);
  const previous = previousAt ? new Date(previousAt) : undefined;
  // Fifteen minutes separates a resumed exchange; every date boundary stays visible.
  if (
    previous &&
    previous.toDateString() === date.toDateString() &&
    date.getTime() - previous.getTime() < 15 * 60_000
  )
    return null;
  const label =
    date.toDateString() === today
      ? t("workspace.messageToday", { time: messageClock(date, language) })
      : messageDateTime(date, language);
  return firstTopicMessage ? `${label} · ${t("workspace.newTopic")}` : label;
}

/** 24-hour clock time, the same format the separators use. */
export function messageClock(date: Date, language: Language) {
  return date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function messageDateTime(date: Date, language: Language) {
  return date.toLocaleString(language, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
