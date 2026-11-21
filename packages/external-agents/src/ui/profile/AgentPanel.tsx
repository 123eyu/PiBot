import { agentDescriptor, type ExternalAgentMethodResults } from "@pibot/external-agents-contract";
import {
  hostPlatform,
  SettingsRow,
  SettingsSection,
  useNavigation,
  useRpc,
  useT,
} from "@pibot/renderer-kit";
import { Button, Icon } from "@pibot/ui";
import { useCallback, useEffect, useState } from "react";
import styles from "../agents/agents.module.css";
import { ConfirmUnisolatedDialog } from "../agents/ConfirmUnisolatedDialog.tsx";
import { errorKey, megabytes } from "../agents/shared.tsx";
import { AGENTS_REVISION } from "../agents/use-agents.ts";
import { AgentIsolation } from "./AgentIsolation.tsx";
import { AgentCommands, AgentSettingsForm, differsFromDefaults } from "./AgentSettings.tsx";
import { useAgentOptions } from "./use-agent-options.ts";

type Info = ExternalAgentMethodResults["externalAgents.bot"];

/**
 * The agent tab of an agent Bot's panel (maintainers 2026-11-14: "agent 的设置放在这里"): the Bot's
 * defaults for model, mode, effort, speed and the agent's other settings, this topic's own
 * choices, and everything that used to sit in Settings › 外部 Agent for this agent: program and
 * version (detect again, install guide, sign-in command), adapter, sandbox allowances and network
 * list, and on Windows the unisolated confirmation and its revoke.
 */
export function AgentPanel({ botId, conversationId }: { botId: string; conversationId?: string }) {
  const t = useT();
  const { peer } = useRpc();
  const { revisions, bumpRevision } = useNavigation();
  const revision = revisions[AGENTS_REVISION] ?? 0;
  const [info, setInfo] = useState<Info>();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const windows = (hostPlatform() ?? "darwin") === "win32";
  const defaults = useAgentOptions(botId);
  const topic = useAgentOptions(botId, conversationId, !!conversationId);
  // Maintainers 2026-11-14: the tab edits the Bot's defaults; a topic shows up only while it runs with
  // its own choices (it kept them, or the agent's live session differs).
  const ownChoices = !!conversationId && differsFromDefaults(topic.options, defaults.options);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and attempt are refetch triggers.
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    setFailed(false);
    peer
      .call("externalAgents.bot", { botId }, { signal: controller.signal, timeoutMs: 30_000 })
      .then(setInfo)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [peer, botId, revision, attempt]);
  const act = useCallback(
    async (key: string, action: () => Promise<unknown>) => {
      setBusy(key);
      setFailure(undefined);
      try {
        await action();
        bumpRevision(AGENTS_REVISION);
      } catch (error) {
        setFailure(t(errorKey(error)));
      } finally {
        setBusy(undefined);
      }
    },
    [bumpRevision, t],
  );
  if (failed)
    return (
      <p role="alert" className={styles.error}>
        {t("errors.agent_unavailable")}
      </p>
    );
  if (!info)
    return (
      <p role="status" className={styles.note}>
        {t("common.loading")}
      </p>
    );
  const { bot, detected } = info;
  const descriptor = bot.agentId === "custom" ? undefined : agentDescriptor(bot.agentId);
  const name = descriptor?.name ?? bot.name;
  const adapter = descriptor?.launch.kind === "adapter" ? descriptor.launch.adapter : undefined;
  const subject = bot.agentId === "custom" ? { botId: bot.botId } : {};
  const call = (method: "externalAgents.installAdapter" | "externalAgents.removeAdapter") =>
    peer ? peer.call(method, { agentId: bot.agentId }, { timeoutMs: 600_000 }) : Promise.resolve();
  return (
    <div className={styles.stack}>
      {windows && (
        <p className={styles.band} data-tone="warn">
          <Icon name="warning" size={16} />
          {t("externalAgents.windows.band")}
        </p>
      )}
      {defaults.notices.includes("no_per_command_ask") && (
        <p className={styles.band} data-tone="warn">
          <Icon name="warning" size={16} />
          {t("externalAgents.noPerCommandAsk", { name: bot.name })}
        </p>
      )}
      <SettingsSection title={t("externalAgents.panel.botDefaults")}>
        <div className={styles.inlineSettings}>
          <AgentSettingsForm
            state={{
              ...defaults,
              // A new default can make the open topic differ: look at it again.
              change: (value) => defaults.change(value).finally(topic.refresh),
            }}
            botName={bot.name}
          />
        </div>
      </SettingsSection>
      {ownChoices && (
        <SettingsSection title={t("externalAgents.panel.thisTopic")}>
          <div className={styles.inlineSettings}>
            <AgentSettingsForm
              state={{
                ...topic,
                change: (value) => topic.change(value).finally(defaults.refresh),
              }}
              botName={bot.name}
              topic
            />
          </div>
        </SettingsSection>
      )}
      {!!(topic.options ?? defaults.options)?.commands.length && (
        <SettingsSection title={t("externalAgents.session.commands")}>
          <div className={styles.inlineSettings}>
            <AgentCommands state={topic.options ? topic : defaults} botName={bot.name} />
          </div>
        </SettingsSection>
      )}
      <SettingsSection title={t("externalAgents.profile.program")}>
        <SettingsRow
          icon="terminal"
          tone="blue"
          label={detected?.version ?? bot.custom?.command ?? name}
          note={detected?.program ?? (descriptor ? t("externalAgents.profile.programMissing") : "")}
        >
          {descriptor && (
            <Button
              variant="pill"
              loading={busy === "detect"}
              disabled={!!busy}
              onClick={() =>
                void act("detect", async () => {
                  await peer?.call(
                    "externalAgents.detect",
                    { refresh: true },
                    { timeoutMs: 90_000 },
                  );
                  setAttempt((value) => value + 1);
                })
              }
            >
              {t("externalAgents.detectAgain")}
            </Button>
          )}
        </SettingsRow>
        {descriptor && !detected?.installed && (
          <SettingsRow icon="info" tone="amber" label={t("externalAgents.notFound")}>
            <a
              className={styles.link}
              href={descriptor.installUrl}
              target="_blank"
              rel="noreferrer"
            >
              {t("externalAgents.installHelp")} ↗
            </a>
          </SettingsRow>
        )}
        {descriptor && (
          <SettingsRow
            icon="user"
            tone="green"
            label={t("externalAgents.profile.accountValue", { name })}
            note={`${t("externalAgents.profile.accountNote", { vendor: descriptor.vendor })} · ${t(
              "externalAgents.panel.signIn",
              { command: descriptor.loginCommand },
            )}`}
          />
        )}
        {adapter && (
          <SettingsRow
            icon="download"
            tone="blue"
            label={`${adapter.name.split("/").at(-1)} ${adapter.version}`}
            note={`${megabytes(adapter.bytes)} · ${
              detected?.adapter?.installed
                ? t("externalAgents.settings.adapterInstalled")
                : t("externalAgents.settings.adapterMissing")
            } · ${t("externalAgents.settings.adapterNote")}`}
          >
            <Button
              variant="pill"
              loading={busy === "adapter"}
              disabled={!!busy}
              onClick={() =>
                void act("adapter", () =>
                  call(
                    detected?.adapter?.installed
                      ? "externalAgents.removeAdapter"
                      : "externalAgents.installAdapter",
                  ),
                )
              }
            >
              {t(
                detected?.adapter?.installed
                  ? "externalAgents.settings.remove"
                  : // The Bot was made with an older pinned adapter: Pi Bot's update brought a new one.
                    bot.adapterVersion && bot.adapterVersion !== adapter.version
                    ? "externalAgents.settings.update"
                    : "externalAgents.settings.download",
              )}
            </Button>
          </SettingsRow>
        )}
      </SettingsSection>
      <AgentIsolation
        info={info}
        busy={busy}
        shareMemory={(enabled) =>
          void act("memory", async () => {
            const result = await peer?.call("externalAgents.setMemorySharing", { botId, enabled });
            if (result)
              setInfo((current) =>
                current
                  ? { ...current, bot: { ...current.bot, shareUserMemory: result.enabled } }
                  : current,
              );
          })
        }
        revoke={() =>
          void act("revoke", () =>
            peer
              ? peer.call("externalAgents.revokeUnisolated", { agentId: bot.agentId, ...subject })
              : Promise.resolve(),
          )
        }
        confirm={() => setConfirming(true)}
      />
      {failure && (
        <p role="alert" className={styles.error}>
          {failure}
        </p>
      )}
      {confirming && (
        <ConfirmUnisolatedDialog
          agentId={bot.agentId}
          {...subject}
          name={bot.name}
          onClose={() => setConfirming(false)}
          onConfirmed={() => {
            setConfirming(false);
            bumpRevision(AGENTS_REVISION);
          }}
        />
      )}
    </div>
  );
}
