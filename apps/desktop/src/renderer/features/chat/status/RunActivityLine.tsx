import { type LiveRunActivity, runActivityText } from "@pibot/client-core";
import { useT } from "@pibot/renderer-kit";
import { useEffect, useState } from "react";
import styles from "../chat.module.css";

export function RunActivityLine({ activity }: { activity: LiveRunActivity }) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    // Not a live region: the seconds tick every second and would be announced every second.
    <span className={styles.runActivity} aria-live="off">
      {runActivityText(activity, now, t, {
        waiting: (seconds) => t("chat.activity.waiting", { seconds }),
        preparing: (tool, characters, seconds) =>
          t("chat.activity.preparing", { tool, characters, seconds }),
        executing: (tool, seconds) => t("chat.activity.executing", { tool, seconds }),
        generatingImage: (seconds) => t("chat.activity.generatingImage", { seconds }),
      })}
    </span>
  );
}
