import { useLanguage, useText } from "../runtime/context.tsx";

const pad = (n: number) => String(n).padStart(2, "0");
function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
/** Chat-list style times: clock today, "yesterday", weekday within a week, then month/day. */
export function useTimeText() {
  const t = useText(),
    language = useLanguage();
  const locale = language === "zh" ? "zh-CN" : "en";
  const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const list = (iso: string, now = new Date()) => {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return "";
    const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
    if (days <= 0) return clock(date);
    if (days === 1) return t("yesterday");
    if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
    return new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(date);
  };
  return {
    clock(iso: string) {
      return clock(new Date(iso));
    },
    list,
    /** Day prefix plus clock, e.g. the time stamp above a chat thread. */
    stamp(iso: string, now = new Date()) {
      const date = new Date(iso);
      const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
      const day =
        days <= 0
          ? t("today")
          : days === 1
            ? t("yesterday")
            : new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" }).format(date);
      return `${day} ${clock(date)}`;
    },
    ago(iso: string, now = Date.now()) {
      const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
      if (!Number.isFinite(minutes) || minutes < 1) return t("justNow");
      if (minutes < 60) return t("minutesAgo", { count: minutes });
      if (minutes < 24 * 60) return t("hoursAgo", { count: Math.floor(minutes / 60) });
      return list(iso);
    },
    duration(ms: number) {
      const total = Math.max(0, Math.round(ms / 1000));
      const h = Math.floor(total / 3600),
        m = Math.floor((total % 3600) / 60),
        s = total % 60;
      if (h) return t("hours", { h, m });
      if (m) return t("minutes", { m, s });
      return t("seconds", { s });
    },
  };
}
