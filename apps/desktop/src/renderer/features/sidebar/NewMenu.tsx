import type { TranslationKey } from "@pibot/i18n";
import { hostPlatform, useT } from "@pibot/renderer-kit";
import { Button, type IconName, IconTile, type Tone } from "@pibot/ui";
import { useRef } from "react";
import { menuKeys, useMenuPopover } from "../workspace/profile/use-menu-popover.ts";
import styles from "./sidebar.module.css";

export type NewMenuAction = "bot" | "group" | "import" | "section";

/** Maintainers 2026-11-13 (batch1 `plus`): what the sidebar ＋ can make, one colour per kind. */
const ROWS: readonly {
  id: NewMenuAction;
  icon: IconName;
  tone: Tone;
  title: TranslationKey;
  note: TranslationKey;
}[] = [
  {
    id: "bot",
    icon: "bot",
    tone: "violet",
    title: "workspace.newBot",
    note: "workspace.createNote",
  },
  {
    id: "group",
    icon: "users",
    tone: "teal",
    title: "workspace.newGroup",
    note: "workspace.groupNote",
  },
  {
    id: "import",
    icon: "download",
    tone: "blue",
    title: "builtin.custom.import",
    note: "workspace.newImportNote",
  },
  {
    id: "section",
    icon: "folder",
    tone: "amber",
    title: "workspace.newSectionItem",
    note: "workspace.newSectionNote",
  },
];

/**
 * Anchored under the ＋; ↑↓ / Home / End move, Enter picks, Esc or a click outside closes.
 * ⌘1–4 (Ctrl+1–4) pick a row directly, taking over the old new-chat page's quick picks.
 */
export function NewMenu({
  opener,
  x,
  y,
  close,
  choose,
}: {
  opener: HTMLElement;
  x: number;
  y: number;
  close(): void;
  choose(action: NewMenuAction): void;
}) {
  const t = useT();
  const menu = useRef<HTMLDivElement>(null);
  useMenuPopover(menu, opener, x, y, close);
  const mod = hostPlatform() === "darwin" ? "⌘" : "Ctrl+";
  const pick = (action: NewMenuAction) => {
    close();
    choose(action);
  };
  return (
    <div
      ref={menu}
      id="sidebar-new-menu"
      popover="manual"
      role="menu"
      aria-label={t("workspace.new")}
      className={`${styles.menu} ${styles.newMenu}`}
      onKeyDown={(event) => {
        const row =
          (event.metaKey || event.ctrlKey) && /^[1-4]$/.test(event.key)
            ? ROWS[Number(event.key) - 1]
            : undefined;
        if (row) {
          event.preventDefault();
          pick(row.id);
          return;
        }
        menuKeys(event, close);
      }}
    >
      {ROWS.map((row, index) => (
        <Button
          key={row.id}
          variant="ghost"
          role="menuitem"
          data-new-menu={row.id}
          aria-keyshortcuts={`${mod === "⌘" ? "Meta" : "Control"}+${index + 1}`}
          onClick={() => pick(row.id)}
        >
          <IconTile icon={row.icon} tone={row.tone} size="lg" />
          <span className={styles.newMenuText}>
            <span className={styles.newMenuTitle}>{t(row.title)}</span>
            <span className={styles.newMenuNote}>{t(row.note)}</span>
          </span>
          <kbd className={styles.newMenuKey}>{`${mod}${index + 1}`}</kbd>
        </Button>
      ))}
    </div>
  );
}
