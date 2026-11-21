import { useT } from "@pibot/renderer-kit";
import { useRef } from "react";
import styles from "./office.module.css";

export function OfficeSheetTabs({
  names,
  selected,
  panelId,
  select,
}: {
  names: string[];
  selected: number;
  panelId: string;
  select(index: number): void;
}) {
  const t = useT();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className={styles.sheetTabs} role="tablist" aria-label={t("office.sheet")}>
      {names.map((name, index) => (
        <button
          key={name}
          type="button"
          role="tab"
          ref={(node) => {
            tabs.current[index] = node;
          }}
          aria-selected={selected === index}
          aria-controls={panelId}
          tabIndex={selected === index ? 0 : -1}
          title={name}
          onClick={() => select(index)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? names.length - 1
                  : (index + (event.key === "ArrowRight" ? 1 : -1) + names.length) % names.length;
            select(next);
            tabs.current[next]?.focus();
            tabs.current[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
          }}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
