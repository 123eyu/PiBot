import { type IconName, IconTile, type Tone } from "@pibot/ui";
import type { CSSProperties } from "react";
import styles from "./starter-cards.module.css";

// Plan blue, write pink, learn amber, brainstorm violet; a role's own starters reuse the cycle.
const LOOK: readonly [IconName, Exclude<Tone, "red" | "neutral">][] = [
  ["menu", "blue"],
  ["edit", "pink"],
  ["bulb", "amber"],
  ["star", "violet"],
];

/** Conversation starters as soft cards; shared by an empty chat and the welcome's last step. */
export function StarterCards({
  items,
  disabled,
  onPick,
}: {
  items: readonly string[];
  disabled?: boolean;
  onPick(text: string): void;
}) {
  return (
    <div className={styles.grid}>
      {items.map((text, index) => {
        const [icon, tone] = LOOK[index % LOOK.length] ?? ["star", "violet"];
        return (
          <button
            key={text}
            type="button"
            className={styles.card}
            style={{ "--starter-c": `var(--avatar-${tone})` } as CSSProperties}
            disabled={disabled}
            onClick={() => onPick(text)}
          >
            <IconTile icon={icon} tone={tone} size="lg" className={styles.tile} />
            <span>{text}</span>
          </button>
        );
      })}
    </div>
  );
}
