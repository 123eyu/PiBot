import type { Bot, Group } from "@pibot/plugins-contract/full";
import { type Peer, useRpcEvent, useSettings, useWorkspace } from "@pibot/renderer-kit";
import { type SkillCatalogItem, skillLabels } from "@pibot/skills-contract/full";
import { Button, Icon } from "@pibot/ui";
import { type ReactNode, useCallback, useState } from "react";
import { useConnectorAction, useConnectorPage } from "../../shell/remote.ts";
import { ConnectorFeedback, ConnectorPagination } from "../ConnectorFeedback.tsx";
import { ConnectorPanel } from "../ConnectorPanel.tsx";
import styles from "./connections.module.css";
import { FacePicker, Faces, GroupFace, letterTone, monogram } from "./Faces.tsx";
import type { SkillEditorSlot, SkillExtrasSlot } from "./WriteSkillPanel.tsx";

const SEARCH_AFTER = 8;
const toolNames: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  pi: "pi",
  opencode: "OpenCode",
};

function useOrigin() {
  const { t } = useSettings();
  const { bots } = useWorkspace();
  return (item: SkillCatalogItem) => {
    if (item.originTool)
      return t("connections.skill.from", { tool: toolNames[item.originTool] ?? item.originTool });
    if (item.origin === "builtin") return t("connections.skill.builtin");
    if (item.origin === "team") return t("connections.skill.team");
    if (item.origin === "imported") return t("connections.skill.imported");
    // Same words as the Bot's own skill list, which says who made it rather than who stored it.
    if (item.origin === "taught") return t("connections.skill.taught");
    const bot = bots.find((entry) => entry.id === item.botId);
    return t("connections.skill.own", { bot: bot?.name ?? "Pi" });
  };
}

/**
 * Every skill the Bots and groups have plus the brought-over ones, one row each; the
 * right side is who uses it, or 「给 Bot 用」 when nobody does. Search appears once the list is long.
 */
export function SkillsTab({
  snapshot,
  empty,
  bar,
  editor,
  extras,
}: {
  snapshot: number;
  empty: ReactNode;
  bar: ReactNode;
  editor: SkillEditorSlot;
  extras: SkillExtrasSlot;
}) {
  const { t, language } = useSettings();
  const workspace = useWorkspace();
  const origin = useOrigin();
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<SkillCatalogItem>();
  useRpcEvent("skills.changed", () => setVersion((value) => value + 1));
  // The unfiltered total decides whether the search box is worth showing.
  const [total, setTotal] = useState(0);
  const load = useCallback(
    async (peer: Peer, signal: AbortSignal, cursor?: string) => {
      const page = await peer.call(
        "skills.catalog",
        { cursor, limit: 50, ...(query.trim() ? { query: query.trim() } : {}) },
        { signal },
      );
      if (!query.trim()) setTotal(page.total);
      return page;
    },
    [query],
  );
  const page = useConnectorPage(load, snapshot + version);
  const items = page.value?.items ?? [];
  const bots = workspace.bots.filter((bot) => !bot.archivedAt);
  const groups = workspace.groups.filter((group) => !group.archivedAt);
  const searchable = total > SEARCH_AFTER || !!query;
  // A renamed or redescribed skill moves to another row key; the copy it opened stays the same.
  const current =
    open &&
    (items.find((item) => item.key === open.key) ??
      items.find((item) => item.skillId === open.skillId));
  if (!page.loading && !page.error && !items.length && !query) return <>{empty}</>;
  return (
    <>
      {bar}
      {/* Maintainers 2026-11-13: writing a skill starts from the page's ＋ 添加 menu only; a second
          「写技能」 button here duplicated it. */}
      {searchable && (
        <div className={styles.toolbar}>
          <label className={styles.search}>
            <Icon name="search" size={14} />
            <input
              type="search"
              aria-label={t("connections.searchSkills")}
              placeholder={t("connections.searchSkills")}
              value={query}
              maxLength={200}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
        </div>
      )}
      <ConnectorFeedback loading={page.loading} error={page.error} retry={page.refresh} />
      <div className={styles.rows}>
        {items.map((item) => {
          // A built-in skill reads in the interface language; other skills keep their one name.
          const label = skillLabels(item, language);
          const users = bots.filter((bot) => item.bots.includes(bot.id));
          const usedBy = groups.filter((group) => item.groups.includes(group.id));
          return (
            <div key={item.key} className={styles.row}>
              <button type="button" className={styles.rowOpen} onClick={() => setOpen(item)}>
                <span className={styles.icon} data-tone={letterTone(label.name)} aria-hidden="true">
                  {monogram(label.name)}
                </span>
                <span className={styles.rowText}>
                  <b>{label.name}</b>
                  <div>
                    {label.description} <span className={styles.origin}>· {origin(item)}</span>
                  </div>
                </span>
              </button>
              {users.length || usedBy.length ? (
                <Faces bots={users} groups={usedBy.map((group) => ({ group, members: bots }))} />
              ) : (
                <Button variant="secondary" onClick={() => setOpen(item)}>
                  {t("connections.action.give")}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {!page.loading && !page.error && !items.length && (
        <p className={styles.note}>{t("connections.skill.noMatch")}</p>
      )}
      <ConnectorPagination previous={page.previous} next={page.next} disabled={page.loading} />
      {current && (
        <SkillPanel
          item={current}
          origin={origin(current)}
          bots={bots}
          groups={groups}
          editor={editor}
          extras={extras}
          changed={page.refresh}
          close={() => setOpen(undefined)}
        />
      )}
    </>
  );
}

function SkillPanel({
  item,
  origin,
  bots,
  groups,
  editor,
  extras,
  changed,
  close,
}: {
  item: SkillCatalogItem;
  origin: string;
  bots: Bot[];
  groups: Group[];
  editor: SkillEditorSlot;
  extras: SkillExtrasSlot;
  changed(): void;
  close(): void;
}) {
  const { t, language } = useSettings();
  const action = useConnectorAction(changed);
  const label = skillLabels(item, language);
  const usedBy = groups.filter((group) => item.groups.includes(group.id));
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  // Only what the person wrote themselves; built-in, team and imported skills stay as they came.
  const editable = item.origin === "taught" && !item.originTool;
  if (editing)
    return (
      <ConnectorPanel
        title={t("connections.skill.editTitle", { name: label.name })}
        close={() => setEditing(false)}
        busy={saving}
      >
        {item.copies > 1 && (
          <p className={styles.note}>
            {t("connections.skill.editOne", {
              owner: copyOwner(t, item, bots, groups),
              count: item.copies - 1,
            })}
          </p>
        )}
        {editor({
          skillId: item.skillId,
          ...(item.groupId ? { groupId: item.groupId } : {}),
          botId: item.botId,
          busy: setSaving,
          close: () => setEditing(false),
          saved: () => {
            setEditing(false);
            changed();
          },
        })}
      </ConnectorPanel>
    );
  return (
    <ConnectorPanel title={label.name} close={close} busy={action.busy}>
      <div className={styles.panelHead}>
        <span className={styles.icon} data-tone={letterTone(label.name)} aria-hidden="true">
          {monogram(label.name)}
        </span>
        <div>
          <small>
            {t("connections.tab.skills")} · {origin}
          </small>
        </div>
      </div>
      <p className={styles.note}>{label.description}</p>
      {editable && (
        <div className={styles.actions}>
          <Button variant="secondary" onClick={() => setEditing(true)}>
            {t("connections.skill.edit")}
          </Button>
        </div>
      )}
      {/* Source/version, runtime and update blocks; the detail page owns the actions. */}
      {extras({
        skillId: item.skillId,
        ...(item.groupId ? { groupId: item.groupId } : {}),
        botId: item.botId,
        name: label.name,
      })}
      <section className={styles.section}>
        <h3>{t("connections.panel.who")}</h3>
        <FacePicker
          bots={bots}
          groups={[]}
          isOn={(_kind, id) => item.bots.includes(id)}
          toggle={(_kind, botId) =>
            void action.run((peer, signal) =>
              peer.call(
                "skills.catalogAssign",
                {
                  skillId: item.skillId,
                  ...(item.groupId ? { groupId: item.groupId } : {}),
                  botId,
                  enabled: !item.bots.includes(botId),
                },
                // Assigning a large skill copies thousands of files (minutes);
                // the default 30 s aborted it and left the toggle half-applied.
                { signal, timeoutMs: 30 * 60_000 },
              ),
            )
          }
          disabled={action.disabled}
        />
        <p className={styles.note}>{t("connections.skill.note")}</p>
        <ConnectorFeedback loading={false} error={action.error} retry={changed} />
      </section>
      {usedBy.length > 0 && (
        <section className={styles.section}>
          <p className={styles.note}>{t("connections.skill.groups")}</p>
          <div className={styles.faces}>
            {usedBy.map((group) => (
              <span key={group.id} className={styles.faces} title={group.name}>
                <GroupFace group={group} bots={bots} size={22} />
                <small>{group.name}</small>
              </span>
            ))}
          </div>
        </section>
      )}
      {/* Built-in methods are only viewed and assigned. */}
      {item.origin !== "builtin" &&
        (confirming ? (
          <section className={styles.section}>
            <p>{t("connections.skill.deleteConfirm", { name: label.name })}</p>
            <div className={styles.actions}>
              <Button
                variant="secondary"
                disabled={action.busy}
                onClick={() => setConfirming(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                className={styles.dangerButton}
                loading={action.busy}
                disabled={action.disabled}
                onClick={() =>
                  void action
                    .run((peer, signal) =>
                      peer.call(
                        "skills.catalogDelete",
                        {
                          skillId: item.skillId,
                          ...(item.groupId ? { groupId: item.groupId } : {}),
                          confirmed: true,
                        },
                        { signal },
                      ),
                    )
                    .then((result) => {
                      if (result) close();
                    })
                }
              >
                {t("connections.skill.delete")}
              </Button>
            </div>
          </section>
        ) : (
          <button type="button" className={styles.danger} onClick={() => setConfirming(true)}>
            {t("connections.skill.deleteMenu")}
          </button>
        ))}
    </ConnectorPanel>
  );
}

/** Whose copy the editor changes: the representative's Bot, and its group for a group copy. */
function copyOwner(
  t: ReturnType<typeof useSettings>["t"],
  item: SkillCatalogItem,
  bots: Bot[],
  groups: Group[],
) {
  const bot = bots.find((entry) => entry.id === item.botId)?.name ?? "Pi";
  const group = item.groupId && groups.find((entry) => entry.id === item.groupId);
  return group ? t("connections.skill.inGroup", { bot, group: group.name }) : bot;
}
