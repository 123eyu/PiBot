import type { TranslationKey } from "@pibot/i18n";
import { useNavigation, useRpc, useSettings, useT } from "@pibot/renderer-kit";
import { skillLabels } from "@pibot/skills-contract/full";
import { Button } from "@pibot/ui";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useSkillsPorts } from "../shell/ports.tsx";
import { skillError } from "./presentation.ts";
import styles from "./skills.module.css";
import { useCatalogChoices } from "./use-catalog-choices.ts";

type Wanted = ReadonlyMap<string, boolean>;
const want = (map: Wanted, id: string, on: boolean): Wanted => new Map(map).set(id, on);

/**
 * 「从连接选择」 (maintainers 2026-11-01): the skills and MCP already on the connections page, each
 * ticked when this Bot (or, in a group, this member here / this group) already has it. Owner
 * 2026-11-13: a tick applies at once. In a group the first skill change replaces the member's
 * default skills there, so skill ticks wait until that is confirmed; after that they apply at once.
 */
export function ConnectionPicker({
  botId,
  botName,
  groupId,
  connections,
  close,
}: {
  botId: string;
  botName: string;
  groupId?: string;
  /** False for image Bots: they call no tools, so an MCP would never apply. */
  connections: boolean;
  close(): void;
}) {
  const t = useT();
  const { language } = useSettings();
  const { peer } = useRpc();
  const navigation = useNavigation();
  const { useConnectionChoices } = useSkillsPorts();
  const skills = useCatalogChoices(botId, groupId);
  const mcp = useConnectionChoices(
    groupId ? { kind: "group", id: groupId } : { kind: "bot", id: botId },
  );
  const [skillWants, setSkillWants] = useState<Wanted>(new Map());
  const [mcpWants, setMcpWants] = useState<Wanted>(new Map());
  // Group skill ticks held back until the replace-defaults confirmation is ticked.
  const [staged, setStaged] = useState<Wanted>(new Map());
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const locked = useRef(false);
  const needsConfirmation = !!groupId && (staged.size > 0 || confirmed);
  const [error, setError] = useState<TranslationKey>();
  const title = useId();
  const doneButton = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    doneButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || locked.current) return;
      event.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  // Rows are disabled while a write runs, so writes never overlap.
  const writing = async (work: () => Promise<TranslationKey | undefined>) => {
    if (!peer || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(undefined);
    const failed = await work();
    locked.current = false;
    setBusy(false);
    if (failed) setError(failed);
  };
  const applySkills = (changes: readonly [string, boolean][]) =>
    writing(async () => {
      if (!peer) return undefined;
      const byKey = new Map(skills.items.map((item) => [item.key, item]));
      setProgress({ done: 0, total: changes.length });
      for (const [key, enabled] of changes) {
        const item = byKey.get(key);
        if (!item) continue;
        try {
          await peer.call(
            "skills.catalogAssign",
            {
              skillId: item.skillId,
              groupId: item.groupId,
              targetGroupId: groupId,
              botId,
              enabled,
            },
            // Copying a skill package reads its folder (bounded to 30 s in brain).
            { timeoutMs: 60_000 },
          );
        } catch (failure) {
          // What already landed must show as ticked; the ticks not written fall back to the server.
          const unwritten = changes.slice(changes.findIndex(([k]) => k === key)).map(([k]) => k);
          setSkillWants((map) => {
            const next = new Map(map);
            for (const k of unwritten) next.delete(k);
            return next;
          });
          skills.retry();
          return skillError(failure);
        }
        setProgress((current) => ({ ...current, done: current.done + 1 }));
      }
      return undefined;
    });
  const toggleSkill = (id: string, on: boolean) => {
    setSkillWants((map) => want(map, id, on));
    const item = skills.items.find((row) => row.key === id);
    if (groupId && !confirmed) {
      setStaged((map) => {
        const next = new Map(map);
        if (item && on === skills.isOn(item)) next.delete(id);
        else next.set(id, on);
        return next;
      });
      return;
    }
    void applySkills([[id, on]]);
  };
  const toggleMcp = (id: string, on: boolean) => {
    setMcpWants((map) => want(map, id, on));
    void writing(async () => {
      const failed = await mcp.apply(new Map([[id, on]]));
      if (failed)
        setMcpWants((map) => {
          const next = new Map(map);
          next.delete(id);
          return next;
        });
      return failed;
    });
  };
  return (
    <div className={styles.overlay}>
      <div
        className={`${styles.dialog} ${styles.wideDialog}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
      >
        <h2 id={title}>{t("skills.pick.title", { bot: botName })}</h2>
        <p>{t(groupId ? "skills.pick.introGroup" : "skills.pick.intro", { bot: botName })}</p>
        <h3 className={styles.subhead}>{t("skills.pick.skills")}</h3>
        <PickList
          rows={skills.items.map((item) => {
            // Built-in skills are offered in the interface language.
            const label = skillLabels(item, language);
            return {
              id: item.key,
              name: label.name,
              description:
                item.origin === "builtin"
                  ? `${t("skills.pick.builtin")} · ${label.description}`
                  : label.description,
              on: skillWants.get(item.key) ?? skills.isOn(item),
            };
          })}
          disabled={busy || !peer}
          toggle={toggleSkill}
          empty={t("skills.pick.skillsEmpty")}
          loading={skills.loading}
          error={skills.error}
          retry={skills.retry}
          more={
            skills.more && (
              <Button variant="pill" disabled={skills.loading} onClick={() => void skills.next()}>
                {t("skills.more")}
              </Button>
            )
          }
        />
        {connections && (
          <>
            <h3 className={styles.subhead}>{t("skills.pick.mcp")}</h3>
            <PickList
              rows={mcp.rows.map((row) => ({ ...row, on: mcpWants.get(row.id) ?? row.on }))}
              disabled={busy || !peer}
              toggle={toggleMcp}
              empty={t("skills.pick.mcpEmpty")}
              loading={mcp.loading}
              error={mcp.error}
              retry={mcp.retry}
            />
          </>
        )}
        <p className={styles.pickFoot}>
          <span>{t("skills.pick.elsewhere")}</span>
          <Button
            variant="pill"
            disabled={busy}
            onClick={() => {
              close();
              navigation.openPage("connectors");
            }}
          >
            {t("skills.pick.openConnections")}
          </Button>
        </p>
        {needsConfirmation && (
          <label className={styles.pickRow}>
            <input
              type="checkbox"
              checked={confirmed}
              // Once confirmed the group has its own list; unticking would not undo that.
              disabled={busy || confirmed}
              onChange={(event) => {
                if (!event.target.checked) return;
                setConfirmed(true);
                const changes = [...staged];
                setStaged(new Map());
                void applySkills(changes);
              }}
            />
            {t("skills.pick.confirmGroup")}
          </label>
        )}
        {busy && <p role="status">{t("skills.pick.saving", progress)}</p>}
        {error && (
          <p role="alert" className={styles.error}>
            {t(error)}
          </p>
        )}
        <div className={styles.dialogActions}>
          <Button
            ref={doneButton}
            variant="primary"
            disabled={busy}
            // Unconfirmed group ticks were never written; closing drops them.
            onClick={close}
          >
            {t("skills.pick.done")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PickList({
  rows,
  disabled,
  toggle,
  empty,
  loading,
  error,
  retry,
  more,
}: {
  rows: readonly { id: string; name: string; description: string; on: boolean }[];
  disabled: boolean;
  toggle(id: string, on: boolean): void;
  empty: string;
  loading: boolean;
  error?: TranslationKey;
  retry(): void;
  more?: ReactNode;
}) {
  const t = useT();
  return (
    <>
      {!!rows.length && (
        <div className={styles.list}>
          {rows.map((row) => (
            <label key={row.id} className={styles.pickRow}>
              <input
                type="checkbox"
                checked={row.on}
                disabled={disabled}
                onChange={(event) => toggle(row.id, event.target.checked)}
              />
              <span className={styles.text}>
                <span className={styles.name}>{row.name}</span>
                {row.description && (
                  <span className={styles.meta} title={row.description}>
                    {row.description}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      )}
      {loading && <p className={styles.note}>{t("common.loading")}</p>}
      {!loading && !error && !rows.length && <p className={styles.note}>{empty}</p>}
      {error && (
        <p role="alert" className={styles.error}>
          {t(error)}{" "}
          <Button variant="pill" onClick={retry}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {more}
    </>
  );
}
