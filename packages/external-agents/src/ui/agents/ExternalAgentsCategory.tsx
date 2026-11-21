import { AGENTS, type ExternalAgentId, type KnownAgentId } from "@pibot/external-agents-contract";
import { useNavigation, useT } from "@pibot/renderer-kit";
import { Chip } from "@pibot/ui";
import { useState } from "react";
import styles from "./agents.module.css";
import { CreateAgentDialog } from "./CreateAgentDialog.tsx";
import { CustomAgentDialog } from "./CustomAgentDialog.tsx";
import { AgentLogo } from "./shared.tsx";
import { AGENTS_REVISION, useAgents } from "./use-agents.ts";

/**
 * The card names where the program lives without spelling out the account folder, which ended
 * up in screenshots and screen shares (video dry run 2026-11-20); hovering still shows it whole.
 */
function homeRelative(path: string) {
  return path.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/, "~");
}

/** Only an installed agent can become a Bot; a missing one offers its install guide. */
function AgentCard({
  agentId,
  name,
  meta,
  path,
  installUrl,
  state,
  onOpen,
}: {
  agentId: KnownAgentId;
  name: string;
  meta: string;
  /** Where detection found the program (PATH or a common install folder). */
  path?: string | null;
  installUrl: string;
  state: "installed" | "missing" | "unknown";
  onOpen(): void;
}) {
  const t = useT();
  const text = (
    <span className={styles.agentText}>
      <b>{name}</b>
      <small>{meta}</small>
      {path && (
        <small className={styles.agentPath} title={path}>
          {homeRelative(path)}
        </small>
      )}
      <span className={styles.agentState}>
        {state === "installed" && <Chip tone="ok">{t("externalAgents.installed")}</Chip>}
        {state === "missing" && <Chip>{t("externalAgents.notInstalled")}</Chip>}
        {state === "missing" && (
          <a className={styles.link} href={installUrl} target="_blank" rel="noreferrer">
            {t("externalAgents.installHelp")} ↗
          </a>
        )}
      </span>
    </span>
  );
  return state === "installed" ? (
    <button type="button" className={styles.agent} onClick={onOpen}>
      <AgentLogo agentId={agentId} />
      {text}
    </button>
  ) : (
    <div className={styles.agent} data-missing>
      <AgentLogo agentId={agentId} />
      {text}
    </div>
  );
}

/** Opens the chat of a new agent Bot; every host of the role browser lands in the same place. */
export function useAgentCreated() {
  const { navigate, bumpRevision } = useNavigation();
  return (botId: string) => {
    bumpRevision(AGENTS_REVISION);
    navigate({ name: "chat", botId });
  };
}

/**
 * The 「外部 Agent」 category of New Bot's role browser (external-agents.html `pick`): agents found
 * on this computer with their versions, an install link for the missing ones, and a custom command.
 */
export function ExternalAgentsCategory() {
  const t = useT();
  const agents = useAgents();
  const created = useAgentCreated();
  const [open, setOpen] = useState<ExternalAgentId>();
  return (
    <div className={styles.stack}>
      <p className={styles.note}>
        {t("externalAgents.categoryHint")}{" "}
        {agents.state === "ready" && (
          <button
            type="button"
            className={styles.link}
            disabled={agents.refreshing}
            onClick={agents.retry}
          >
            {t(agents.refreshing ? "externalAgents.detecting" : "externalAgents.detectAgain")}
          </button>
        )}
      </p>
      {agents.state === "loading" && (
        <p role="status" className={styles.note}>
          {t("externalAgents.detecting")}
        </p>
      )}
      {agents.state === "failed" && (
        <p role="alert" className={styles.error}>
          {t("externalAgents.detectFailed")}{" "}
          <button type="button" className={styles.link} onClick={agents.retry}>
            {t("externalAgents.retry")}
          </button>
        </p>
      )}
      <div className={styles.agents}>
        {AGENTS.map((descriptor) => {
          const found = agents.agent(descriptor.id);
          const installed = !!found?.installed;
          return (
            <AgentCard
              key={descriptor.id}
              agentId={descriptor.id}
              name={descriptor.name}
              installUrl={descriptor.installUrl}
              path={installed ? found?.program : undefined}
              meta={
                installed
                  ? found?.version
                    ? t("externalAgents.localProgram", {
                        vendor: descriptor.vendor,
                        version: found.version,
                      })
                    : t("externalAgents.localProgramNoVersion", { vendor: descriptor.vendor })
                  : agents.state === "ready"
                    ? t("externalAgents.notFound")
                    : descriptor.vendor
              }
              state={installed ? "installed" : agents.state === "ready" ? "missing" : "unknown"}
              onOpen={() => setOpen(descriptor.id)}
            />
          );
        })}
        <button type="button" className={styles.agent} onClick={() => setOpen("custom")}>
          <AgentLogo agentId="custom" />
          <span className={styles.agentText}>
            <b>{t("externalAgents.custom")}</b>
            <small>{t("externalAgents.customHint")}</small>
            <span className={styles.agentState}>
              <Chip>{t("externalAgents.customFill")}</Chip>
            </span>
          </span>
        </button>
      </div>
      <p className={styles.note}>{t("externalAgents.privacyNote")}</p>
      {open === "custom" && (
        <CustomAgentDialog onClose={() => setOpen(undefined)} onCreated={created} />
      )}
      {open && open !== "custom" && (
        <CreateAgentDialog
          agentId={open as KnownAgentId}
          detected={agents.agent(open)}
          onClose={() => setOpen(undefined)}
          onCreated={created}
        />
      )}
    </div>
  );
}
