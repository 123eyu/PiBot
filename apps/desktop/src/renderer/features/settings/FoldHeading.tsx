import { Icon } from "@pibot/ui";
import styles from "./permissions/permissions.module.css";

/** A collapsible block heading with its item count ("12+" while more pages exist). */
export function FoldHeading({
  title,
  count,
  open,
  toggle,
  controls,
}: {
  title: string;
  count?: string;
  open: boolean;
  toggle(): void;
  controls: string;
}) {
  return (
    <h2 className={styles.foldHeading}>
      <button
        type="button"
        className={styles.fold}
        aria-expanded={open}
        aria-controls={controls}
        onClick={toggle}
      >
        <Icon
          name="chevronRight"
          size={13}
          style={{ transform: open ? "rotate(90deg)" : undefined }}
        />
        <span>{title}</span>
        {count !== undefined && <span className={styles.foldCount}>{count}</span>}
      </button>
    </h2>
  );
}
