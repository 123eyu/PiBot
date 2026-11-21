// Shows a cached external-agent account problem without putting provider errors in the transcript.
import type { AgentAccountStatus } from "@pibot/external-agents-contract";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import styles from "../chat.module.css";

export function AgentAccountStatusBand({
  name,
  status,
  command,
  onCheck,
  onProfile,
}: {
  name: string;
  status: AgentAccountStatus;
  command: string;
  onCheck: () => void;
  onProfile: () => void;
}) {
  const t = useT();
  if (status.kind === "unknown") return null;
  const login = status.kind === "login_required";
  return (
    <div className={`${styles.notice} ${styles.band}`} data-tone="warn" role="status">
      <span>
        {login
          ? t("externalAgents.status.login", { name, command })
          : t("externalAgents.status.quota", { name })}
      </span>
      {login ? (
        <Button onClick={() => void navigator.clipboard.writeText(command)}>
          {t("externalAgents.status.copy")}
        </Button>
      ) : (
        <Button onClick={onProfile}>{t("externalAgents.status.profile")}</Button>
      )}
      <Button onClick={onCheck}>{t("externalAgents.status.check")}</Button>
    </div>
  );
}
