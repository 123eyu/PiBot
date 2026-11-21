import { type CustomAgent, CustomAgentSchema } from "@pibot/external-agents-contract";
import { hostPlatform, Overlay, useT } from "@pibot/renderer-kit";
import { Button, TextField } from "@pibot/ui";
import { useId, useState } from "react";
import { AgentTagInput } from "./AgentTagInput.tsx";
import styles from "./agents.module.css";
import { CreateAgentDialog } from "./CreateAgentDialog.tsx";
import { AgentLogo } from "./shared.tsx";

const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * "Custom launch command": program, arguments (one per line, never a shell line), the agent's
 * own data folders and its network allowlist. Then the same explanation card as a known agent.
 */
export function CustomAgentDialog({
  onClose,
  onCreated,
}: {
  onClose(): void;
  onCreated(botId: string): void;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("acp");
  const [folders, setFolders] = useState("");
  const [domains, setDomains] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [custom, setCustom] = useState<CustomAgent>();
  if (custom)
    return (
      <CreateAgentDialog agentId="custom" custom={custom} onClose={onClose} onCreated={onCreated} />
    );
  const next = () => {
    const parsed = CustomAgentSchema.safeParse({
      name: name.trim(),
      command: command.trim(),
      args: lines(args),
      readWrite: lines(folders),
      network: lines(domains),
    });
    setInvalid(!parsed.success);
    if (parsed.success) setCustom(parsed.data);
  };
  const area = (
    key: string,
    label: string,
    hint: string,
    value: string,
    change: (value: string) => void,
  ) => (
    <label className={styles.field} htmlFor={`${id}-${key}`}>
      {label}
      <textarea
        id={`${id}-${key}`}
        value={value}
        spellCheck={false}
        onChange={(event) => change(event.currentTarget.value)}
      />
      <small>{hint}</small>
    </label>
  );
  return (
    <Overlay
      title={t("externalAgents.custom.title")}
      titleIcon={<AgentLogo agentId="custom" />}
      tone="neutral"
      close={onClose}
      footer={
        <div className={styles.footer}>
          <span>{(!name.trim() || !command.trim()) && t("externalAgents.custom.required")}</span>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!name.trim() || !command.trim()} onClick={next}>
            {t("externalAgents.create.create")}
          </Button>
        </div>
      }
    >
      <div className={styles.stack}>
        <section className={styles.createCard}>
          <h2 className={styles.cardTitle}>{t("externalAgents.custom.program")}</h2>
          <TextField
            label={t("externalAgents.custom.name")}
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <TextField
            label={t("externalAgents.custom.command")}
            description={t("externalAgents.custom.commandHint")}
            value={command}
            maxLength={1024}
            spellCheck={false}
            onChange={(event) => setCommand(event.currentTarget.value)}
          />
          {area(
            "args",
            t("externalAgents.custom.args"),
            t("externalAgents.custom.argsHint"),
            args,
            setArgs,
          )}
        </section>
        {/* W3: the folders and domains it may open are sandbox allowances; Windows has none. */}
        {hostPlatform() !== "win32" && (
          <section className={styles.createCard}>
            <h2 className={styles.cardTitle}>{t("externalAgents.custom.access")}</h2>
            <AgentTagInput
              label={t("externalAgents.custom.folders")}
              hint={t("externalAgents.custom.foldersHint")}
              value={folders}
              change={setFolders}
            />
            <AgentTagInput
              label={t("externalAgents.custom.domains")}
              hint={t("externalAgents.custom.domainsHint")}
              value={domains}
              change={setDomains}
            />
          </section>
        )}
        {invalid && (
          <p role="alert" className={styles.error}>
            {t("externalAgents.custom.invalid")}
          </p>
        )}
      </div>
    </Overlay>
  );
}
