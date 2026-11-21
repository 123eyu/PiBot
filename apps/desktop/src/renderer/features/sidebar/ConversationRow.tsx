import type { AgentErrorCode, Bot, Group, SidebarEntry } from "@pibot/protocol";
import { BotAvatar, botAvatarLook, useSettings, useT } from "@pibot/renderer-kit";
import { GroupAvatar, Icon } from "@pibot/ui";
import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";
import { AgentAccountBadge } from "./AgentAccountBadge.tsx";
import { firstSentence, messagePreview } from "./preview.ts";
import styles from "./sidebar.module.css";

export function ConversationRow({
  entry,
  bot,
  group,
  members,
  time,
  pinned,
  selected,
  preview,
  failed,
  status,
  activity,
  editing,
  renameError,
  busy,
  open,
  menu,
  rename,
  stopEditing,
}: {
  entry: SidebarEntry;
  bot?: Bot;
  group?: Group;
  members: Bot[];
  time?: string;
  pinned: boolean;
  selected: boolean;
  preview: string;
  failed?: AgentErrorCode;
  status?: "waiting" | "running" | "queued";
  /** More specific running text, e.g. "Using Keynote" while the Bot operates the computer. */
  activity?: string;
  editing: boolean;
  /** Why the typed name was not saved (a taken Bot name); the field stays open. */
  renameError?: string;
  busy: boolean;
  open(): void;
  menu(event: { x: number; y: number; opener: HTMLElement }): void;
  rename(name: string): Promise<void>;
  stopEditing(): void;
}) {
  const t = useT();
  const { language } = useSettings();
  const name = bot?.name ?? group?.name ?? "";
  const [value, setValue] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  useLayoutEffect(() => {
    if (editing) {
      cancelled.current = false;
      setValue(name);
      input.current?.focus();
      input.current?.select();
    }
  }, [editing, name]);
  return (
    <div
      className={pinned ? `${styles.row} ${styles.pinnedRow}` : styles.row}
      // The open chat (and its rename field) take the Bot's colour; groups use teal.
      style={
        {
          "--row-c": `var(--avatar-${group ? "teal" : botAvatarLook(bot).color})`,
        } as CSSProperties
      }
    >
      <button
        type="button"
        className={styles.bot}
        aria-current={selected ? "page" : undefined}
        data-sidebar-key={entry.conversationKey}
        data-main-bot={bot?.isMain || undefined}
        aria-haspopup="menu"
        onClick={open}
        onContextMenu={(event) => {
          event.preventDefault();
          menu({ x: event.clientX, y: event.clientY, opener: event.currentTarget });
        }}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            menu({ x: rect.left, y: rect.bottom, opener: event.currentTarget });
          }
        }}
      >
        <span className={styles.avatar}>
          {group ? (
            <GroupAvatar size={44}>
              {group.members.map((member) => (
                <BotAvatar
                  key={member.botId}
                  bot={members.find((b) => b.id === member.botId)}
                  unknown={!members.some((b) => b.id === member.botId)}
                />
              ))}
            </GroupAvatar>
          ) : (
            <BotAvatar
              bot={bot}
              size={44}
              state={status === "waiting" ? "waiting" : status === "running" ? "working" : "idle"}
            />
          )}
          {bot?.isMain && (
            <span className={styles.mainBadge} role="img" aria-label={t("sidebar.mainBot")}>
              <Icon name="star" size={10} />
            </span>
          )}
        </span>
        <span className={styles.summary}>
          <span className={styles.nameLine}>
            <strong>
              {name}{" "}
              {entry.unread && (
                <span
                  className={styles.unread}
                  role="img"
                  aria-label={t("workspace.unreadLabel")}
                />
              )}
            </strong>
            {bot?.kind === "agent" && <AgentAccountBadge botId={bot.id} />}
            {(time || pinned) && (
              <span className={styles.meta}>
                {pinned && (
                  <span className={styles.pinMark} role="img" aria-label={t("workspace.pinned")}>
                    <Icon name="pin" size={11} />
                  </span>
                )}
                {time && (
                  <time dateTime={time} title={new Date(time).toLocaleString(language)}>
                    {new Date(time).toLocaleTimeString(language, {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </time>
                )}
              </span>
            )}
          </span>
          <span
            className={
              status === "waiting" || (!status && group?.paused)
                ? styles.waiting
                : !status && failed
                  ? styles.failed
                  : undefined
            }
          >
            {activity && status !== "waiting"
              ? activity
              : status
                ? t(
                    status === "waiting"
                      ? "workspace.inbox"
                      : status === "queued"
                        ? "workspace.queued"
                        : "workspace.running",
                  )
                : group?.paused
                  ? // Maintainers 2026-11-20: a paused group says so instead of its last message.
                    t("workspace.groupPaused")
                  : failed
                    ? t("workspace.failedPreview", { reason: firstSentence(t(`errors.${failed}`)) })
                    : messagePreview(preview)}
          </span>
        </span>
      </button>
      {editing && (
        <form
          className={styles.rename}
          onSubmit={(event) => {
            event.preventDefault();
            // Enter commits through blur, so a name is saved by exactly one path.
            input.current?.blur();
          }}
        >
          <input
            ref={input}
            aria-label={t("workspace.name")}
            aria-invalid={!!renameError || undefined}
            aria-describedby={renameError ? `${entry.conversationKey}-rename-error` : undefined}
            value={value}
            maxLength={200}
            disabled={busy}
            onChange={(event) => setValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                cancelled.current = true;
                stopEditing();
              }
            }}
            onBlur={() => {
              // Maintainers 2026-11-13: the name saves when the field loses focus; Esc leaves it as it was.
              if (cancelled.current) return;
              const next = value.trim();
              if (next && next !== name) void rename(next);
              else stopEditing();
            }}
          />
          {renameError && (
            <p
              id={`${entry.conversationKey}-rename-error`}
              role="alert"
              className={styles.renameError}
            >
              {renameError}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
