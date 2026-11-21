import type { AgentSessionOptions, AgentSetting } from "@pibot/external-agents-contract";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useId, useState } from "react";
import styles from "../agents/agents.module.css";
import { ModelPicker } from "./ModelPicker.tsx";
import { SelectRow } from "./SelectRow.tsx";
import type { AgentOptionsState } from "./use-agent-options.ts";

/** A model id the agent did not list; the agent itself accepts or refuses it. */
function CustomModel({ onApply }: { onApply(value: string): Promise<boolean> }) {
  const t = useT();
  const id = useId();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const typed = value.trim();
  return (
    <div className={styles.settingRow}>
      <label htmlFor={id}>{t("externalAgents.session.customModel")}</label>
      <div className={styles.settingControl}>
        <div className={styles.customModel}>
          <input
            id={id}
            className={styles.settingSearch}
            value={value}
            maxLength={600}
            spellCheck={false}
            aria-describedby={`${id}-hint`}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          <Button
            variant="pill"
            loading={busy}
            disabled={!typed || busy}
            onClick={() => {
              setBusy(true);
              void onApply(typed).then((ok) => {
                setBusy(false);
                if (ok) setValue("");
              });
            }}
          >
            {t("externalAgents.session.customModelApply")}
          </Button>
        </div>
        <small id={`${id}-hint`} className={styles.note}>
          {t("externalAgents.session.customModelHint")}
        </small>
      </div>
    </div>
  );
}

/**
 * Model (any it lists, or a typed id it accepts), mode, reasoning effort, speed and the agent's
 * other settings together (maintainers 2026-11-14): only what this agent offers. `topic` forms change
 * that topic now (and, as the brain does, the Bot's default); otherwise the default for new topics.
 */
export function AgentSettingsForm({
  state,
  botName,
  topic = false,
}: {
  state: AgentOptionsState;
  botName: string;
  topic?: boolean;
}) {
  const t = useT();
  const { options, change, failed } = state;
  const settingLabel = (item: AgentSetting) =>
    item.kind === "effort"
      ? t("externalAgents.session.effort")
      : item.kind === "speed"
        ? t("externalAgents.session.speed")
        : item.name;
  const empty = !!options && !options.mode && !options.model && !options.settings.length;
  return (
    <div className={styles.settings}>
      {empty && (
        <p className={styles.note}>{t("externalAgents.session.none", { name: botName })}</p>
      )}
      {options?.model && (
        <ModelPicker
          label={t("externalAgents.session.model")}
          list={options.model}
          onChange={(value) => void change({ kind: "model", value })}
        />
      )}
      {/* Also before the agent listed its models: a known id can be set for the first session. */}
      {options && <CustomModel onApply={(value) => change({ kind: "model", value })} />}
      {options?.refusedModel && (
        <p role="alert" className={styles.error}>
          {t("externalAgents.session.modelRefusedAtStart", {
            name: botName,
            id: options.refusedModel,
          })}
        </p>
      )}
      {options?.mode && (
        <SelectRow
          label={t("externalAgents.session.mode")}
          list={options.mode}
          onChange={(value) => void change({ kind: "mode", value })}
        />
      )}
      {options?.settings.map((item) => (
        <SelectRow
          key={item.configId}
          label={settingLabel(item)}
          list={item}
          onChange={(value) => void change({ kind: "config", configId: item.configId, value })}
        />
      ))}
      {!empty && options && (
        <p className={styles.note}>
          {t(topic ? "externalAgents.session.topicHint" : "externalAgents.session.botHint")}
        </p>
      )}
      {failed && (
        <p role="alert" className={styles.error}>
          {failed === "refused"
            ? t("externalAgents.session.modelRefused", { name: botName })
            : t("externalAgents.session.failed")}
        </p>
      )}
    </div>
  );
}

/** The agent's own slash commands (the composer's "/" menu lists the same). */
export function AgentCommands({ state, botName }: { state: AgentOptionsState; botName: string }) {
  const t = useT();
  const commands = state.options?.commands ?? [];
  if (!commands.length) return null;
  return (
    <div className={styles.commands}>
      <p className={styles.note}>{t("externalAgents.session.commandsHint", { name: botName })}</p>
      <ul>
        {commands.map((command) => (
          <li key={command.name}>
            <code>/{command.name}</code>
            {command.description && <span>{command.description}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Whether a topic runs with anything other than the Bot's defaults (its own overrides). */
export function differsFromDefaults(topic?: AgentSessionOptions, defaults?: AgentSessionOptions) {
  if (!topic || !defaults) return false;
  const picks = (options: AgentSessionOptions) =>
    JSON.stringify([
      options.model?.current ?? null,
      options.mode?.current ?? null,
      options.settings.map((item) => [item.configId, item.current]),
    ]);
  return picks(topic) !== picks(defaults);
}
