import { type IconName, IconTile, Switch, type Tone } from "@pibot/ui";
import type { ReactNode } from "react";
import styles from "../shell/routines.module.css";

const MARKS: Record<string, { icon: IconName; tone: Tone }> = {
  read_file: { icon: "file", tone: "blue" },
  list_dir: { icon: "folder", tone: "amber" },
  write_file: { icon: "edit", tone: "orange" },
  run_command: { icon: "terminal", tone: "orange" },
  web: { icon: "globe", tone: "teal" },
  login: { icon: "key", tone: "violet" },
  paid_image: { icon: "image", tone: "pink" },
};

/** One pre-authorization — its kind's tile, what it allows, why it cannot apply, a switch. */
export function PreauthRow({
  kind,
  label,
  problem,
  checked,
  disabled,
  change,
}: {
  kind: string;
  label: string;
  problem?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  change(checked: boolean): void;
}) {
  const mark = MARKS[kind] ?? { icon: "shield", tone: "neutral" };
  return (
    <div className={`${styles.optRow} ${problem ? styles.invalid : ""}`}>
      <IconTile icon={mark.icon} tone={mark.tone} size="lg" />
      <div className={styles.optText}>
        <strong>{label}</strong>
        {problem && <small>{problem}</small>}
      </div>
      <Switch label={label} checked={checked} disabled={disabled} onCheckedChange={change} />
    </div>
  );
}
