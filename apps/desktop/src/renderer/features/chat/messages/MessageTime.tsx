import { useSettings } from "@pibot/renderer-kit";
import { memo, useEffect, useState } from "react";
import styles from "../chat.module.css";
import { messageTimeLabel } from "./message-time-label.ts";

export function useTimelineDay() {
  const [day, setDay] = useState(() => new Date().toDateString());
  useEffect(() => {
    const timer = setInterval(() => setDay(new Date().toDateString()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return day;
}

// Rendered once per message on every streaming commit; primitive props let memo skip them.
export const MessageTime = memo(function MessageTime({
  at,
  previousAt,
  firstTopicMessage,
  today,
}: {
  at: string;
  previousAt?: string;
  firstTopicMessage: boolean;
  today: string;
}) {
  const { t, language } = useSettings();
  const label = messageTimeLabel({ at, previousAt, firstTopicMessage, today, language, t });
  if (label === null) return null;
  return (
    <div className={styles.timeSeparator}>
      <time dateTime={at}>{label}</time>
    </div>
  );
});
