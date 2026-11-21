import { botPanelStyles as styles } from "@pibot/renderer-kit";
import { Button, Icon, IconButton, type IconName, IconTile, type Tone } from "@pibot/ui";
import { type ReactNode, useRef, useState } from "react";
import { menuKeys, useMenuPopover } from "./use-menu-popover.ts";

export interface PanelMenuItem {
  id: string;
  label: string;
  run(): void;
  disabled?: boolean;
  /** Destructive actions are red and sit last, after a divider. */
  danger?: boolean;
  /** The item's leading tile; omitted = looked up by `id` (see ITEM_LOOK). */
  icon?: readonly [IconName, Tone];
}

/**
 * Every menu item leads with a small tile, one colour per kind of action, so the same
 * action looks the same in every menu (destructive red, archive orange, duplicate violet …).
 */
const ITEM_LOOK: Record<string, readonly [IconName, Tone]> = {
  duplicate: ["copy", "violet"],
  export: ["send", "blue"],
  delete: ["trash", "red"],
  archive: ["box", "orange"],
  restore: ["refresh", "green"],
  edit: ["edit", "blue"],
  rename: ["edit", "blue"],
  view: ["file", "blue"],
  teach: ["hand", "pink"],
  pick: ["folder", "amber"],
};
const FALLBACK_LOOK: readonly [IconName, Tone] = ["more", "neutral"];

/**
 * A visible menu glyph keeps secondary actions discoverable in compact panels. Used for the panels'
 * duplicate / export / delete actions and for the skills「导入 ▾」choice.
 */
export function PanelMenu({
  label,
  items,
  trigger,
  width = 200,
  disabled = false,
}: {
  label: string;
  items: readonly PanelMenuItem[];
  /** A text trigger (with a chevron); omitted = the compact menu icon. */
  trigger?: ReactNode;
  width?: number;
  disabled?: boolean;
}) {
  const [menu, setMenu] = useState<{ opener: HTMLElement; x: number; y: number }>();
  const open = (opener: HTMLElement) => {
    if (menu) return setMenu(undefined);
    const rect = opener.getBoundingClientRect();
    setMenu({ opener, x: rect.right - width, y: rect.bottom + 6 });
  };
  return (
    <>
      {trigger ? (
        <Button
          variant="pill"
          className={styles.menuTrigger}
          aria-label={label}
          title={label}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          disabled={disabled}
          onClick={(event) => open(event.currentTarget)}
        >
          {trigger}
          <Icon name="chevron" size={12} />
        </Button>
      ) : (
        <IconButton
          variant="circle"
          label={label}
          title={label}
          className={styles.moreButton}
          aria-haspopup="menu"
          aria-expanded={!!menu}
          disabled={disabled}
          onClick={(event) => open(event.currentTarget)}
        >
          <Icon name="more" size={17} />
        </IconButton>
      )}
      {menu && (
        <MenuPopover
          {...menu}
          label={label}
          width={width}
          items={items}
          close={() => setMenu(undefined)}
        />
      )}
    </>
  );
}

function MenuPopover({
  opener,
  x,
  y,
  label,
  width,
  items,
  close,
}: {
  opener: HTMLElement;
  x: number;
  y: number;
  label: string;
  width: number;
  items: readonly PanelMenuItem[];
  close(): void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useMenuPopover(menu, opener, x, y, close);
  return (
    <div
      ref={menu}
      popover="manual"
      role="menu"
      aria-label={label}
      className={styles.menu}
      style={{ width }}
      onKeyDown={(event) => menuKeys(event, close)}
    >
      {items.map((item) => (
        <Button
          key={item.id}
          variant="ghost"
          role="menuitem"
          disabled={item.disabled}
          className={item.danger ? styles.menuDanger : undefined}
          onClick={() => {
            close();
            item.run();
          }}
        >
          <IconTile
            icon={(item.icon ?? ITEM_LOOK[item.id] ?? FALLBACK_LOOK)[0]}
            tone={item.danger ? "red" : (item.icon ?? ITEM_LOOK[item.id] ?? FALLBACK_LOOK)[1]}
            size="sm"
          />
          {item.label}
        </Button>
      ))}
    </div>
  );
}
