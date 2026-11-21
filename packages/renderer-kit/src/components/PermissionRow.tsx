import { Chip, type IconName, IconTile, SegmentedControl, type Tone } from "@pibot/ui";
import type { ReactNode } from "react";
import { useT } from "../settings/context.ts";
import styles from "../widgets/bot-panel.module.css";

/**
 * One permission row in the Bot panel. It shows only the value in effect; a Bot-specific
 * value is marked「已单独设置」with「恢复」(back to following the global setting).
 * Maintainers 2026-11-13: in the narrow side panel the label line (tile, label, chip, 恢复) sits above a
 * full-width segmented control; a wide container keeps both on one line (container query).
 */
export function PermissionRow<T extends string>({
  label,
  value,
  options,
  overridden,
  disabled,
  change,
  restore,
  note,
  icon,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  overridden: boolean;
  disabled: boolean;
  change(value: T): void;
  restore(): void;
  note?: ReactNode;
  /** An optional coloured tile that marks the row's permission category. */
  icon?: { name: IconName; tone: Tone };
}) {
  const t = useT();
  return (
    <div className={`${styles.cardRow} ${styles.permissionRow}`}>
      <div className={styles.permissionInner}>
        <span className={styles.permissionHead}>
          {icon && <IconTile icon={icon.name} tone={icon.tone} size="lg" />}
          <span className={styles.rowText}>
            <span className={styles.permissionTitle}>
              <strong>{label}</strong>
              {overridden && (
                <>
                  <Chip tone="warn">{t("panel.overridden")}</Chip>
                  <button
                    type="button"
                    className={styles.permissionRestore}
                    disabled={disabled}
                    aria-label={t("panel.restoreNamed", { name: label })}
                    onClick={restore}
                  >
                    {t("panel.restore")}
                  </button>
                </>
              )}
            </span>
            {note && <small>{note}</small>}
          </span>
        </span>
        <SegmentedControl<T>
          label={label}
          className={`${styles.segSmall} ${styles.permissionSeg}`}
          value={value}
          disabled={disabled}
          options={options}
          onValueChange={change}
        />
      </div>
    </div>
  );
}
