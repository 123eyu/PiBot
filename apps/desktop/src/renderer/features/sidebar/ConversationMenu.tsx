import type { SidebarEntry } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { ShareTeamButton } from "@pibot/teams/ui";
import { Button, type IconName, IconTile, type Tone } from "@pibot/ui";
import { useLayoutEffect, useRef, useState } from "react";
import { menuKeys, useMenuPopover } from "../workspace/profile/use-menu-popover.ts";
import styles from "./sidebar.module.css";

export type MenuAction =
  | "profile"
  | "pin"
  | "move"
  | "read"
  | "rename"
  | "copy"
  | "hide"
  | "delete";
// Every item leads with a coloured tile, one colour per action type.
const MENU_TONES: Record<MenuAction, Tone> = {
  profile: "violet",
  pin: "amber",
  move: "teal",
  read: "blue",
  rename: "blue",
  copy: "neutral",
  hide: "neutral",
  delete: "orange",
};
export function ConversationMenu({
  entry,
  main,
  group,
  x,
  y,
  opener,
  close,
  choose,
}: {
  entry: SidebarEntry;
  main: boolean;
  group: boolean;
  x: number;
  y: number;
  opener: HTMLElement;
  close(): void;
  choose(action: MenuAction): void;
}) {
  const t = useT();
  const [more, setMore] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  useMenuPopover(menu, opener, x, y, close);
  useLayoutEffect(() => {
    const selector = more ? "[data-team-back]" : '[role="menuitem"]';
    menu.current?.querySelector<HTMLButtonElement>(selector)?.focus();
  }, [more]);
  const actions: { id: MenuAction; label: string; icon: IconName; separate?: boolean }[] = [
    ...(!group
      ? [{ id: "profile" as const, label: t("workspace.profile"), icon: "user" as const }]
      : []),
    { id: "pin", label: t(entry.pinnedAt ? "workspace.unpin" : "workspace.pin"), icon: "pin" },
    { id: "move", label: t("workspace.move"), icon: "folder" },
    { id: "read", label: t(entry.unread ? "workspace.read" : "workspace.unread"), icon: "dot" },
    {
      id: "rename",
      label: t(group ? "workspace.renameGroup" : "workspace.rename"),
      icon: "edit",
      separate: true,
    },
    { id: "copy", label: t("workspace.copyId"), icon: "copy", separate: true },
    ...(!main
      ? [
          {
            id: "hide" as const,
            label: t("workspace.hide"),
            icon: "hide" as const,
            separate: true,
          },
          {
            id: "delete" as const,
            label: t(group ? "group.archive" : "workspace.archiveBot"),
            icon: "archive" as const,
          },
        ]
      : []),
  ];
  return (
    <div
      ref={menu}
      popover="manual"
      role="menu"
      aria-label={t("workspace.menu")}
      className={styles.menu}
      onKeyDown={(event) => menuKeys(event, close)}
    >
      {!more &&
        actions.map((action) => (
          <span key={action.id} className={action.separate ? styles.separated : undefined}>
            <Button
              variant="ghost"
              role="menuitem"
              className={action.id === "delete" ? styles.danger : undefined}
              onClick={() => {
                close();
                choose(action.id);
              }}
            >
              <IconTile icon={action.icon} tone={MENU_TONES[action.id]} size="sm" />
              {action.label}
            </Button>
          </span>
        ))}
      {group && (
        <span className={styles.separated}>
          {more ? (
            <>
              <Button variant="ghost" role="menuitem" data-team-back onClick={() => setMore(false)}>
                <IconTile icon="back" tone="neutral" size="sm" />
                {t("teams.backMenu")}
              </Button>
              <ShareTeamButton
                role="menuitem"
                target={{ groupId: entry.conversationKey.slice(6) }}
              />
            </>
          ) : (
            <Button variant="ghost" role="menuitem" onClick={() => setMore(true)}>
              <IconTile icon="more" tone="neutral" size="sm" />
              {t("teams.moreMenu")}
            </Button>
          )}
        </span>
      )}
    </div>
  );
}
