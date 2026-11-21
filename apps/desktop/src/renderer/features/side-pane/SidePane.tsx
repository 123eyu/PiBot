import { useT } from "@pibot/renderer-kit";
import { CloseButton, IconTile, type IconTileProps } from "@pibot/ui";
import { ChangesIcon } from "@pibot/workspaces/ui";
import { type ReactNode, useEffect, useRef } from "react";
import styles from "./side-pane.module.css";
import type { SidePaneControl, SidePaneTab } from "./use-side-pane.ts";

const emptyLook: Record<SidePaneTab, Pick<IconTileProps, "icon" | "tone">> = {
  tasks: { icon: "plan", tone: "amber" },
  changes: { icon: "file", tone: "green" },
  browser: { icon: "globe", tone: "blue" },
  preview: { icon: "eye", tone: "violet" },
};

export interface SidePaneSlot {
  id: SidePaneTab;
  title?: string;
  /** An unavailable page keeps its stable destination and shows an empty state. */
  content: ReactNode | null;
}

/** A single content header; navigation stays in the chat title bar, including empty pages. */
export function SidePane({ pane, slots }: { pane: SidePaneControl; slots: SidePaneSlot[] }) {
  const t = useT();
  const root = useRef<HTMLElement>(null);
  const visible = pane.open;
  useEffect(() => {
    if (!visible) return;
    const node = root.current,
      opener = document.activeElement;
    node?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      if (
        opener instanceof HTMLElement &&
        opener.isConnected &&
        (node?.contains(document.activeElement) || document.activeElement === document.body)
      )
        opener.focus();
    };
  }, [visible]);
  if (!visible) return null;
  const current = slots.find((slot) => slot.id === pane.tab) ?? { id: pane.tab, content: null };
  const labels: Record<SidePaneTab, string> = {
    changes: t("sidePane.changes"),
    tasks: t("agentWork.tasks"),
    browser: t("sidePane.browser"),
    preview: t("preview.title"),
  };
  return (
    <aside
      ref={root}
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          (current.id !== "browser" || current.content === null)
        ) {
          event.preventDefault();
          pane.close();
        }
      }}
      className={styles.pane}
      data-wide={pane.wide || undefined}
      data-full={(pane.full && current.id === "browser") || undefined}
      aria-label={current.title ?? labels[current.id]}
    >
      {!(current.id === "browser" && current.content !== null) && (
        <header className={styles.head}>
          <h2 className={styles.title} title={current.title}>
            {current.title ?? labels[current.id]}
          </h2>
          <span className={styles.grow} />
          <button
            type="button"
            className={styles.wide}
            aria-pressed={pane.wide}
            aria-label={t(pane.wide ? "sidePane.narrow" : "sidePane.wide")}
            title={t(pane.wide ? "sidePane.narrowTitle" : "sidePane.wideTitle")}
            onClick={pane.toggleWide}
          >
            <ChangesIcon name={pane.wide ? "shrink" : "expand"} />
          </button>
          <CloseButton label={t("sidePane.close")} onClick={pane.close} />
        </header>
      )}
      <div className={styles.content}>
        {current.content ?? (
          // An empty page is a tile in the page's colour, a bold title and one note.
          <div role="status" className={styles.empty}>
            <IconTile
              icon={emptyLook[current.id].icon}
              tone={emptyLook[current.id].tone}
              size="lg"
              className={styles.emptyTile}
            />
            <b>{t(`sidePane.emptyTitle.${current.id}`)}</b>
            <p>
              {t(
                current.id === "preview"
                  ? "sidePane.empty.preview"
                  : `sidePane.empty.${current.id}`,
              )}
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
