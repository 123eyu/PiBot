import type { AgentSessionOptions } from "@pibot/external-agents-contract";
import { useT } from "@pibot/renderer-kit";
import { IconTile } from "@pibot/ui";
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import styles from "./skill-commands.module.css";

type Command = AgentSessionOptions["commands"][number];
/** OpenCode lists every skill it has as a command; past this, typing narrows the list. */
const SHOWN = 80;

/**
 * The composer's "/" menu in an external agent's topic. It lists the agent's own commands
 * (ACP `available_commands_update`, kept live by `externalAgents.optionsChanged`) instead of Pi Bot
 * skills, which the agent cannot use. Choosing one only edits the draft to `/name `; the message
 * goes to the agent unchanged and the agent runs the command itself. Same return shape as
 * `useSkillCommands`, so the composer treats both menus alike.
 */
export function useAgentCommandMenu(options: {
  enabled: boolean;
  agentName: string;
  commands: readonly Command[] | undefined;
  text: string;
  edit(text: string): void;
  disabled: boolean;
  textarea: RefObject<HTMLTextAreaElement | null>;
}) {
  const t = useT();
  const id = useId();
  const [dismissed, setDismissed] = useState<string>();
  const [selected, setSelected] = useState(0);
  const caret = useRef<string | undefined>(undefined);
  const list = useRef<HTMLDivElement>(null);
  const pattern = /^\/([^\s/]*)$/u.exec(options.text);
  const open = options.enabled && !!pattern && dismissed !== options.text && !options.disabled;
  const query = (pattern?.[1] ?? "").toLocaleLowerCase();
  const all = options.commands ?? [];
  // Names that start with what was typed first, then names or descriptions that contain it.
  const matches = query
    ? [
        ...all.filter((command) => command.name.toLocaleLowerCase().startsWith(query)),
        ...all.filter(
          (command) =>
            !command.name.toLocaleLowerCase().startsWith(query) &&
            `${command.name} ${command.description}`.toLocaleLowerCase().includes(query),
        ),
      ]
    : all;
  const entries = matches.slice(0, SHOWN);
  const active = Math.min(selected, Math.max(0, entries.length - 1));
  // After a pick, the draft is `/name ` and the agent's input hint says what to type next.
  const picked = /^\/(\S+) $/u.exec(options.text)?.[1];
  const hint =
    options.enabled && picked ? all.find((command) => command.name === picked)?.hint : undefined;

  useEffect(() => {
    setSelected(0);
    setDismissed((current) => (current === options.text ? current : undefined));
  }, [options.text]);
  useLayoutEffect(() => {
    if (caret.current !== undefined && caret.current === options.text) {
      options.textarea.current?.focus();
      options.textarea.current?.setSelectionRange(options.text.length, options.text.length);
      caret.current = undefined;
    }
  }, [options.text, options.textarea]);
  // Arrow keys move past the visible part of a long list: keep the active row in view.
  useEffect(() => {
    if (open)
      list.current?.querySelector(`#${CSS.escape(`${id}-${active}`)}`)?.scrollIntoView({
        block: "nearest",
      });
  }, [open, active, id]);

  const pick = (command: Command) => {
    const text = `/${command.name} `;
    caret.current = text;
    options.edit(text);
    setDismissed(options.text);
    setSelected(0);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, composing: boolean) => {
    if (
      !open ||
      composing ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      event.shiftKey ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey
    )
      return false;
    if (!["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) return false;
    // With nothing to pick, Enter sends what was typed: the agent may know commands it never listed.
    if ((event.key === "Tab" || event.key === "Enter") && !entries.length) return false;
    event.preventDefault();
    if (event.key === "Escape") setDismissed(options.text);
    else if (event.key === "Enter" || event.key === "Tab") {
      const entry = entries[active];
      if (entry) pick(entry);
    } else
      setSelected(
        (value) =>
          (value + (event.key === "ArrowDown" ? 1 : -1) + entries.length) %
          Math.max(1, entries.length),
      );
    return true;
  };
  const title = t("externalAgents.commands.title", { name: options.agentName });
  const popup = open ? (
    <div className={styles.anchor}>
      <div className={styles.menu} ref={list}>
        <p className={styles.heading}>{title}</p>
        <div id={id} role="listbox" aria-label={title}>
          {entries.map((command, index) => (
            <button
              type="button"
              role="option"
              tabIndex={-1}
              id={`${id}-${index}`}
              key={command.name}
              aria-selected={index === active}
              className={styles.option}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(command)}
            >
              <IconTile icon="terminal" tone="blue" className={styles.tile} />
              <span>
                /{command.name}
                {command.hint && <small> {command.hint}</small>}
              </span>
              <small className={styles.clamp} title={command.description}>
                {command.description}
              </small>
            </button>
          ))}
        </div>
        {matches.length > SHOWN && (
          <p className={styles.empty}>
            {t("externalAgents.commands.more", { count: matches.length - SHOWN })}
          </p>
        )}
        {!entries.length &&
          (query ? (
            <p className={styles.empty}>
              {t("externalAgents.commands.noMatch", {
                name: options.agentName,
                query: pattern?.[1] ?? "",
              })}
            </p>
          ) : (
            <div className={styles.none}>
              <IconTile icon="terminal" tone="blue" />
              <span>
                <b>{t("externalAgents.commands.none", { name: options.agentName })}</b>
                <small>{t("externalAgents.commands.noneHint")}</small>
              </span>
            </div>
          ))}
      </div>
    </div>
  ) : hint ? (
    <div className={styles.anchor}>
      <p className={`${styles.menu} ${styles.inputHint}`} role="status">
        {t("externalAgents.commands.hint", { hint })}
      </p>
    </div>
  ) : null;
  return { popup, onKeyDown, open, id, activeId: entries.length ? `${id}-${active}` : undefined };
}
