import type { AutoCheckFolder } from "@pibot/protocol";
import { botPanelStyles as panelStyles, useAction, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useState } from "react";
import styles from "./auto-check.module.css";
import { parseCommands } from "./commands.ts";

/**
 * One folder's check commands with edit / clear / don't check. Shared by the profile
 * panel and the conversation's folder menu; `folder` null = still loading. Maintainers 2026-11-13: the
 * commands save when the field loses focus; 取消 (or Esc) puts the old commands back.
 */
export function FolderCommands({
  folder,
  botName,
  save,
}: {
  folder: AutoCheckFolder | null;
  botName: string;
  save(commands: string[] | null): Promise<void>;
}) {
  const t = useT();
  const task = useAction();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [invalid, setInvalid] = useState(false);
  if (!folder) return null;
  if (!folder.folder) return <p className={panelStyles.note}>{t("autoCheck.folderUnavailable")}</p>;
  const commands = folder.commands;
  const name = folder.folder.home
    ? t("autoCheck.folderHome", { name: botName })
    : folder.folder.name;
  const apply = (value: string[] | null) =>
    task.run(
      () => save(value).then(() => true),
      () => "autoCheck.failed",
    );
  const submit = async () => {
    const parsed = parseCommands(draft);
    if (!parsed) {
      setInvalid(true);
      return;
    }
    // A blur that changed nothing just closes the editor.
    if (commands && parsed.join("\n") === commands.join("\n")) {
      setEditing(false);
      return;
    }
    if (await apply(parsed)) setEditing(false);
  };
  return (
    <div className={styles.folder}>
      <p className={styles.folderName} title={folder.folder.path}>
        {name}
      </p>
      {editing ? (
        <label className={styles.panelEditor}>
          {t("autoCheck.commandsLabel")}
          <textarea
            // biome-ignore lint/a11y/noAutofocus: The user just asked to edit these commands.
            autoFocus
            value={draft}
            spellCheck={false}
            readOnly={task.busy}
            onChange={(event) => {
              setDraft(event.target.value);
              setInvalid(false);
            }}
            onBlur={() => void submit()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
              } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
                event.currentTarget.blur();
            }}
          />
          <small>{t("autoCheck.savesOnBlur")}</small>
          {invalid && <span role="alert">{t("autoCheck.commandsInvalid")}</span>}
        </label>
      ) : commands?.length ? (
        <ul className={styles.folderCommands}>
          {commands.map((command) => (
            <li key={command}>
              <code className={styles.command}>{command}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p className={panelStyles.note}>
          {commands
            ? t("autoCheck.folderSkipped")
            : t("autoCheck.folderUnknown", { name: botName })}
        </p>
      )}
      <div className={styles.folderActions}>
        {editing ? (
          <Button
            variant="ghost"
            disabled={task.busy}
            // Keep focus in the field so its blur does not save what is being cancelled.
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => setEditing(false)}
          >
            {t("autoCheck.cancel")}
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              disabled={task.busy}
              onClick={() => {
                setDraft((commands ?? []).join("\n"));
                setInvalid(false);
                setEditing(true);
              }}
            >
              {t(commands?.length ? "autoCheck.edit" : "autoCheck.set")}
            </Button>
            {commands !== null && (
              <Button variant="ghost" disabled={task.busy} onClick={() => void apply(null)}>
                {t("autoCheck.clear")}
              </Button>
            )}
            {commands?.length !== 0 && (
              <Button variant="ghost" disabled={task.busy} onClick={() => void apply([])}>
                {t("autoCheck.skip")}
              </Button>
            )}
          </>
        )}
      </div>
      <p className={panelStyles.note}>{t("autoCheck.shared")}</p>
      {task.error && (
        <p role="alert" className={panelStyles.error}>
          {t(task.error)}
        </p>
      )}
    </div>
  );
}
