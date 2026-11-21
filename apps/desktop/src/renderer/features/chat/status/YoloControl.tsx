import type { ChatPeer } from "@pibot/client-core";
import { isolationReasonText } from "@pibot/client-core";
import { useAction, useSettings, useT } from "@pibot/renderer-kit";
import { Button, Icon, IconButton, IconTile } from "@pibot/ui";
import { useRef, useState } from "react";
import { Overlay } from "../../workspace/Overlay.tsx";
import { menuKeys, useMenuPopover } from "../../workspace/profile/use-menu-popover.ts";
import workspaceStyles from "../../workspace/workspace.module.css";
import { useGroupTopicArchive, useTopicArchive } from "../topics/use-topic-archive.ts";
import { useConversationYolo } from "./use-conversation-yolo.ts";
import styles from "./yolo.module.css";

/**
 * The conversation header's "more" menu with the YOLO switch, and while it is on a
 * persistent badge with one-click off. Turning it on always goes through the confirm dialog.
 */
export function YoloControl({
  peer,
  conversationId,
  group = false,
  topicBotId,
  topicGroupId,
}: {
  peer: ChatPeer | null | undefined;
  /** The DM topic or group conversation; a new-topic draft has none (and starts off). */
  conversationId?: string;
  group?: boolean;
  /** Topic archival preserves the Bot or group itself and enters a fresh draft. */
  topicBotId?: string;
  topicGroupId?: string;
}) {
  const { t, settings } = useSettings();
  const windows = window.pibot.platform === "win32";
  const { state, set } = useConversationYolo(peer, conversationId);
  const dmArchive = useTopicArchive(peer, topicBotId, conversationId);
  const groupArchive = useGroupTopicArchive(peer, topicGroupId, conversationId);
  const archive = topicGroupId ? groupArchive : dmArchive;
  const action = useAction();
  const [menu, setMenu] = useState<{ opener: HTMLElement; x: number; y: number }>();
  const [confirming, setConfirming] = useState(false);
  if (!state && !archive.available) return null;
  const change = (enabled: boolean) =>
    action.run(
      () => set(enabled),
      () => "yolo.failed",
    );
  return (
    <span className={styles.control}>
      {state?.enabled && (
        <span className={styles.badge} role="status" title={t("yolo.badgeHint")}>
          <span className={styles.badgeLabel}>{t("yolo.badge")}</span>
          <button
            type="button"
            className={styles.badgeOff}
            aria-label={t("yolo.turnOff")}
            title={`${t("yolo.badgeHint")} · ${t("yolo.turnOff")}`}
            disabled={action.busy}
            onClick={() => void change(false)}
          >
            <Icon name="close" size={12} className={styles.badgeClose} />
            <Icon name="warning" size={15} className={styles.badgeCompactIcon} />
          </button>
        </span>
      )}
      <IconButton
        variant="circle"
        label={t("yolo.menu")}
        title={t("yolo.menu")}
        className={styles.more}
        aria-haspopup="menu"
        aria-expanded={!!menu}
        onClick={(event) => {
          if (menu) return setMenu(undefined);
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ opener: event.currentTarget, x: rect.right - 260, y: rect.bottom + 6 });
        }}
      >
        <Icon name="more" size={17} />
      </IconButton>
      {menu && (
        <YoloMenu
          {...menu}
          enabled={state ? state.enabled : undefined}
          close={() => setMenu(undefined)}
          toggle={() => {
            setMenu(undefined);
            if (state?.enabled) void change(false);
            else setConfirming(true);
          }}
          archive={
            archive.available
              ? () => {
                  setMenu(undefined);
                  void archive.run();
                }
              : undefined
          }
          busy={action.busy || archive.busy}
        />
      )}
      {(action.error || archive.error) && !confirming && (
        <span role="alert" className={styles.error}>
          {t(action.error ?? archive.error ?? "yolo.failed")}
        </span>
      )}
      {confirming && state && (
        <Overlay
          icon="bolt"
          tone="orange"
          title={t("yolo.confirmTitle")}
          close={() => setConfirming(false)}
          busy={action.busy}
        >
          <div className={styles.confirm}>
            <p>{t("yolo.confirmIntro")}</p>
            {group && <p>{t("yolo.confirmGroup")}</p>}
            {!state.isolation.available && (
              <p className={styles.risk} role="alert">
                {t(
                  windows
                    ? settings?.yoloUnisolatedCommands
                      ? "yolo.unisolatedEnabled"
                      : "yolo.unisolatedDisabled"
                    : "yolo.unisolated",
                  {
                    reason:
                      isolationReasonText(state.isolation.reason, t) || t("yolo.unisolatedUnknown"),
                  },
                )}
              </p>
            )}
            {/* What YOLO allows and what still asks sit side by side. */}
            <div className={styles.scopes}>
              <section className={styles.scope} data-tone="ok">
                <h2>{t("yolo.skips")}</h2>
                <p>{t(windows ? "yolo.skipsList.windows" : "yolo.skipsList")}</p>
              </section>
              <section className={styles.scope} data-tone="danger">
                <h2>{t("yolo.keeps")}</h2>
                <p>{t("yolo.keepsList")}</p>
                <p>
                  {t(state.isolation.available ? "yolo.keepsSafety" : "yolo.keepsSafetyUnisolated")}
                </p>
              </section>
            </div>
            <p className={styles.note}>{t("yolo.nothingRemembered")}</p>
          </div>
          <div className={workspaceStyles.actions}>
            <Button variant="secondary" disabled={action.busy} onClick={() => setConfirming(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              className={styles.turnOn}
              loading={action.busy}
              onClick={() =>
                void change(true).then((value) => {
                  if (value) setConfirming(false);
                })
              }
            >
              {t("yolo.confirm")}
            </Button>
          </div>
          {action.error && (
            <p role="alert" className={workspaceStyles.error}>
              {t(action.error)}
            </p>
          )}
        </Overlay>
      )}
    </span>
  );
}

function YoloMenu({
  opener,
  x,
  y,
  enabled,
  close,
  toggle,
  archive,
  busy,
}: {
  opener: HTMLElement;
  x: number;
  y: number;
  /** Undefined when this conversation cannot have YOLO (a draft, a routine's topic). */
  enabled: boolean | undefined;
  close(): void;
  toggle(): void;
  archive?: () => void;
  busy: boolean;
}) {
  const t = useT();
  const menu = useRef<HTMLDivElement>(null);
  useMenuPopover(menu, opener, x, y, close);
  return (
    <div
      ref={menu}
      popover="manual"
      role="menu"
      aria-label={t("yolo.menu")}
      className={styles.menu}
      // The menu combines a checkbox switch with the archive action.
      onKeyDown={(event) => {
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          const items = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="menuitemcheckbox"]:not(:disabled), [role="menuitem"]:not(:disabled)',
            ),
          ];
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : event.key === "ArrowDown"
                  ? index + 1
                  : index - 1;
          items[(next + items.length) % items.length]?.focus();
          event.preventDefault();
          return;
        }
        menuKeys(event, close);
      }}
    >
      {enabled !== undefined && (
        <Button
          variant="ghost"
          role="menuitemcheckbox"
          aria-checked={enabled}
          disabled={busy}
          onClick={toggle}
        >
          <IconTile icon="bolt" tone="orange" size="sm" />
          <span className={styles.menuText}>
            <strong>{t("yolo.menuItem")}</strong>
            <span>{t(enabled ? "yolo.menuOn" : "yolo.menuOff")}</span>
          </span>
          <span className={enabled ? styles.switchOn : styles.switchOff} aria-hidden="true" />
        </Button>
      )}
      {archive && (
        <Button variant="ghost" role="menuitem" disabled={busy} onClick={archive}>
          <IconTile icon="box" tone="amber" size="sm" />
          <span className={styles.menuText}>
            <strong>{t("topic.archive")}</strong>
            <span>{t("topic.archiveHint")}</span>
          </span>
        </Button>
      )}
    </div>
  );
}
