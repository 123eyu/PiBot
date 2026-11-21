import type { Skill } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, IconTile } from "@pibot/ui";
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

type Owner = { id: string; name: string };
type Entry = { skill: Skill; owner: Owner };
const PAGE = 50;

/** Selection only edits the draft. The model still reads SKILL.md through the ordinary gate. */
export function useSkillCommands(options: {
  owners: Owner[];
  groupId?: string;
  text: string;
  edit(text: string): void;
  disabled: boolean;
  textarea: RefObject<HTMLTextAreaElement | null>;
}) {
  const { peer } = useRpc();
  const t = useT();
  const id = useId();
  const key = JSON.stringify([
    options.groupId,
    options.owners.map(({ id, name }) => ({ id, name })),
  ]);
  const [dismissed, setDismissed] = useState<string>();
  const [selected, setSelected] = useState(0);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<{
    key: string;
    peer: typeof peer;
    rows: Entry[];
    more: Owner[];
    failed: boolean;
  }>();
  const [loading, setLoading] = useState(false);
  const [pagination, setPagination] = useState({ key, pages: 1 });
  const pages = pagination.key === key ? pagination.pages : 1;
  const caret = useRef<string | undefined>(undefined);
  const pattern = /^\/([^\s/]*)$/u.exec(options.text);
  const open =
    !!pattern && dismissed !== options.text && !options.disabled && options.owners.length > 0;
  useEffect(() => {
    setSelected(0);
    setDismissed((current) => (current === options.text ? current : undefined));
  }, [options.text]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Revision refreshes after skill changes or Retry.
  useEffect(() => {
    if (!open || !peer) return;
    const controller = new AbortController();
    setLoading(true);
    const owners: Owner[] = JSON.parse(key)[1];
    const groupId: string | undefined = JSON.parse(key)[0] ?? undefined;
    void Promise.all(
      owners.map(async (owner) => {
        const rows: Entry[] = [];
        let before: string | undefined;
        let more = false;
        for (let page = 0; page < pages; page++) {
          const skills = await peer.call(
            "skills.list",
            {
              botId: owner.id,
              groupId,
              effective: true,
              enabled: true,
              // Built-in methods are the Bot's planning references, not a user menu.
              builtin: false,
              limit: PAGE,
              before,
            },
            { signal: controller.signal },
          );
          rows.push(
            ...skills
              .filter((skill) => skill.botId === owner.id && skill.enabled)
              .map((skill) => ({ skill, owner })),
          );
          more = skills.length === PAGE;
          before = skills.at(-1)?.id;
          if (!more) break;
        }
        return { rows, more: more ? [owner] : [] };
      }),
    )
      .then(
        (results) => {
          if (!controller.signal.aborted)
            setData({
              key,
              peer,
              rows: results.flatMap((result) => result.rows),
              more: results.flatMap((result) => result.more),
              failed: false,
            });
        },
        () => {
          if (!controller.signal.aborted) setData({ key, peer, rows: [], more: [], failed: true });
        },
      )
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    const off = peer.on("skills.changed", (event) => {
      if (event.groupId === groupId && owners.some((owner) => owner.id === event.botId))
        setRevision((value) => value + 1);
    });
    return () => {
      controller.abort();
      off();
    };
  }, [open, peer, key, pages, revision]);
  const current = data?.key === key && data.peer === peer ? data : undefined;
  const query = (pattern?.[1] ?? "").toLocaleLowerCase();
  const entries = (current?.rows ?? []).filter(({ skill, owner }) =>
    `${owner.name} ${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query),
  );
  const active = Math.min(selected, Math.max(0, entries.length - 1));
  useLayoutEffect(() => {
    if (caret.current !== undefined && caret.current === options.text) {
      options.textarea.current?.focus();
      options.textarea.current?.setSelectionRange(options.text.length, options.text.length);
      caret.current = undefined;
    }
  }, [options.text, options.textarea]);
  const pick = ({ skill, owner }: Entry) => {
    const text = `${options.groupId ? `@${owner.name} ` : ""}${t("skillCommands.use", { name: skill.name })}`;
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
    if (event.key === "Tab" && !entries.length) return false;
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
  const popup = open ? (
    <div className={styles.anchor}>
      <div className={styles.menu}>
        <p className={styles.heading}>{t("skillCommands.title")}</p>
        <div id={id} role="listbox" aria-label={t("skillCommands.title")}>
          {entries.map((entry, index) => (
            <button
              type="button"
              role="option"
              tabIndex={-1}
              id={`${id}-${index}`}
              key={entry.skill.id}
              aria-selected={index === active}
              className={styles.option}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(entry)}
            >
              <IconTile icon="puzzle" tone="violet" className={styles.tile} />
              <span>
                {entry.skill.name}
                {options.groupId && <small> · {entry.owner.name}</small>}
              </span>
              <small>{entry.skill.description}</small>
            </button>
          ))}
        </div>
        {loading ? (
          <p role="status">{t("common.loading")}</p>
        ) : current?.failed ? (
          <p role="alert">{t("skillCommands.failed")}</p>
        ) : (
          !entries.length &&
          (query ? (
            <p className={styles.empty}>
              {t("skillCommands.noMatch", { query: pattern?.[1] ?? "" })}
            </p>
          ) : (
            // Maintainers 2026-11-13: an empty list said only "no match"; say what to do instead.
            <div className={styles.none}>
              <IconTile icon="puzzle" tone="violet" />
              <span>
                <b>{t("skillCommands.none")}</b>
                <small>{t("skillCommands.noneHint")}</small>
              </span>
            </div>
          ))
        )}
        {current?.failed && (
          <Button variant="ghost" onClick={() => setRevision((value) => value + 1)}>
            {t("common.retry")}
          </Button>
        )}
        {!!current?.more.length && pages < 4 && (
          <Button variant="ghost" onClick={() => setPagination({ key, pages: pages + 1 })}>
            {t("skillCommands.more")}
          </Button>
        )}
        {!!current?.more.length && pages === 4 && <p>{t("skillCommands.limit")}</p>}
      </div>
    </div>
  ) : null;
  return {
    popup,
    onKeyDown,
    open,
    hasEntries: entries.length > 0,
    id,
    activeId: entries.length ? `${id}-${active}` : undefined,
  };
}
