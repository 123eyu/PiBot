import { botAvatarLook } from "@pibot/renderer-kit/bot-avatar";
import { Avatar, Button, Icon, IconTile } from "@pibot/ui";
import type { CSSProperties } from "react";
import type { StartupTranslate } from "../../shared/startup-labels.ts";
import type { StartupSnapshot } from "../../shared/startup-snapshot.ts";
import appMenuStyles from "../features/app-menu/app-menu.module.css";
import styles from "../features/sidebar/sidebar.module.css";
import { CachedAvatar, CachedGroupAvatar } from "./startup-avatar.tsx";

type Translate = StartupTranslate;
type Language = "zh" | "en";
type Entry = StartupSnapshot["entries"][number];

/** Same markup and classes as the live Sidebar / ConversationRow, without any data hooks. */
export function CachedSidebar({
  snapshot,
  language,
  t,
}: {
  snapshot: StartupSnapshot;
  language: Language;
  t: Translate;
}) {
  const conversation = snapshot.conversation;
  const selectedKey = conversation?.groupId
    ? `group:${conversation.groupId}`
    : conversation?.botId && `dm:${conversation.botId}`;
  const sections = snapshot.sections ?? [];
  const sectionIds = new Set(sections.map((section) => section.id));
  const regular = snapshot.entries.filter((entry) => !entry.pinned);
  const row = (entry: Entry) => (
    <CachedRow
      key={entry.key}
      entry={entry}
      selected={entry.key === selectedKey}
      language={language}
      t={t}
    />
  );
  return (
    <nav className={styles.sidebar} aria-label={t("sidebar.chats")}>
      <div className={styles.titlebar}>
        <div className={styles.topActions}>
          <Button variant="ghost" aria-label={t("workspace.new")}>
            <Icon name="plus" />
          </Button>
        </div>
      </div>
      <div className={styles.search}>
        <input aria-label={t("workspace.search")} placeholder={t("common.search")} readOnly />
      </div>
      <div className={styles.shortcuts}>
        <Button
          variant="ghost"
          className={styles.shortcut}
          data-tone="amber"
          data-empty={!snapshot.inboxCount || undefined}
          aria-label={`${t("workspace.inbox")} · ${snapshot.inboxCount}`}
        >
          <span className={styles.pendingDot} />
          <span className={styles.shortcutLabel}>{t("workspace.inboxShort")}</span>
          <span className={styles.count}>{snapshot.inboxCount}</span>
        </Button>
        <Button
          variant="ghost"
          className={styles.shortcut}
          data-tone="orange"
          aria-label={t("activity.routines")}
        >
          <Icon name="clock" size={14} />
          <span className={styles.shortcutLabel}>{t("workspace.routinesShort")}</span>
        </Button>
        <Button
          variant="ghost"
          className={styles.shortcut}
          data-tone="teal"
          aria-label={t("audit.title")}
        >
          <Icon name="audit" size={14} />
          <span className={styles.shortcutLabel}>{t("workspace.auditShort")}</span>
        </Button>
      </div>
      <div className={styles.scroll}>
        {!snapshot.entries.length && <p className={styles.empty}>{t("workspace.empty")}</p>}
        {/* WeChat-style pinning: pinned chats are ordinary rows at the top of the same list. */}
        {snapshot.entries.some((e) => e.pinned) && (
          <div className={styles.pinnedBlock}>
            {snapshot.entries.filter((e) => e.pinned).map(row)}
          </div>
        )}
        {regular.filter((e) => !e.sectionId || !sectionIds.has(e.sectionId)).map(row)}
        {sections.map((section) => (
          <section key={section.id} className={styles.section}>
            <div className={styles.sectionHeading}>
              <Button variant="ghost" aria-expanded={!section.collapsed}>
                <Icon
                  name="chevron"
                  size={13}
                  className={styles.sectionChevron}
                  style={{ transform: section.collapsed ? "rotate(-90deg)" : undefined }}
                />
                <span className={styles.sectionName}>{section.name}</span>
              </Button>
              <Button
                variant="ghost"
                className={styles.sectionSettings}
                aria-label={`${section.name} · ${t("workspace.sectionMenu")}`}
              >
                <Icon name="more" size={16} />
              </Button>
            </div>
            {!section.collapsed && regular.filter((e) => e.sectionId === section.id).map(row)}
          </section>
        ))}
      </div>
      <div className={styles.footer}>
        <div className={styles.footerActions}>
          <button type="button" className={appMenuStyles.trigger} aria-label={t("appMenu.title")}>
            {snapshot.userAvatarImage ? (
              <CachedAvatar look={avatarImage} size={36} label={t("appMenu.profile")} />
            ) : (
              <Avatar
                size={36}
                shape="blob"
                color="violet"
                eyes="marks"
                label={t("appMenu.profile")}
              />
            )}
          </button>
          <Button variant="secondary" className={styles.connect}>
            <IconTile icon="link" tone="blue" size="lg" />
            <span className={styles.connectText}>
              <span className={styles.connectTitle}>{t("workspace.connectApps")}</span>
              <span className={styles.connectHint}>{t("workspace.connectHint")}</span>
            </span>
            <Icon name="chevronRight" size={14} className={styles.connectChevron} />
          </Button>
        </div>
      </div>
    </nav>
  );
}
const avatarImage = { shape: "blob", color: "violet", eyes: "marks", image: true };

function CachedRow({
  entry,
  selected,
  language,
  t,
}: {
  entry: Entry;
  selected: boolean;
  language: Language;
  t: Translate;
}) {
  const pinned = !!entry.pinned;
  const size = 44;
  return (
    <div
      className={pinned ? `${styles.row} ${styles.pinnedRow}` : styles.row}
      // Same colour rule as the live row: the Bot's colour, groups teal.
      style={
        {
          "--row-c": `var(--avatar-${entry.key.startsWith("group:") ? "teal" : botAvatarLook({ avatarColor: entry.avatar?.color }).color})`,
        } as CSSProperties
      }
    >
      <button
        type="button"
        className={styles.bot}
        aria-current={selected ? "page" : undefined}
        data-main-bot={entry.main || undefined}
      >
        <span className={styles.avatar}>
          {entry.key.startsWith("group:") ? (
            <CachedGroupAvatar
              members={entry.members}
              memberCount={entry.memberCount}
              size={size}
            />
          ) : (
            <CachedAvatar look={entry.avatar} size={size} label={entry.name} />
          )}
          {entry.main && (
            <span className={styles.mainBadge} role="img" aria-label={t("sidebar.mainBot")}>
              <Icon name="star" size={10} />
            </span>
          )}
        </span>
        <span className={styles.summary}>
          <span className={styles.nameLine}>
            <strong>
              {entry.name}{" "}
              {entry.unread && (
                <span
                  className={styles.unread}
                  role="img"
                  aria-label={t("workspace.unreadLabel")}
                />
              )}
            </strong>
            {(entry.time || pinned) && (
              <span className={styles.meta}>
                {/* The cover is inert; the live row labels this mark. */}
                {pinned && (
                  <span className={styles.pinMark} aria-hidden="true">
                    <Icon name="pin" size={11} />
                  </span>
                )}
                {entry.time && (
                  <time dateTime={entry.time}>
                    {new Date(entry.time).toLocaleTimeString(language, {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </time>
                )}
              </span>
            )}
          </span>
          <span className={entry.failed ? styles.failed : undefined}>{entry.preview ?? ""}</span>
        </span>
      </button>
    </div>
  );
}
