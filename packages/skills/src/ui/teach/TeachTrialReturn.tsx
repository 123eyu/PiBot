import { useNavigation, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import styles from "./teach.module.css";
import { pendingTrialRun } from "./use-teach.ts";

/**
 * Under the trial's reply in chat (maintainers 2026-11-01): the way back to the lesson, which is
 * otherwise several clicks away. Only while that lesson still waits to be saved in this window.
 */
export function TeachTrialReturn({ botId, runId }: { botId: string; runId: string }) {
  const t = useT();
  const { navigate } = useNavigation();
  if (pendingTrialRun(botId) !== runId) return null;
  return (
    <div className={styles.trialReturn}>
      <Button variant="secondary" onClick={() => navigate({ name: "teach", botId })}>
        {t("teach.backToTeach")}
      </Button>
    </div>
  );
}
