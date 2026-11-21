import type { ComputerApp } from "@pibot/computer-use-contract/full";
import { useT } from "@pibot/renderer-kit";
import { Icon } from "@pibot/ui";
import { useDeferredValue, useMemo, useState } from "react";
import styles from "../computer.module.css";

export interface PickerApp extends ComputerApp {
  /** Why the row cannot be toggled (shown instead of a hint); undefined = selectable. */
  locked?: string;
  hint?: string;
}

const RENDER_LIMIT = 300;

/**
 * Searchable checkbox list of this computer's apps (blocklist, always-list, routine
 * preauth). Rendering is capped; search narrows long lists instead of virtualizing them.
 */
export function AppPicker({
  apps,
  checked,
  toggle,
  disabled,
  label,
}: {
  apps: PickerApp[];
  checked(appId: string): boolean;
  toggle(app: ComputerApp, on: boolean): void;
  disabled?: boolean;
  label: string;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const filtered = useMemo(() => {
    const needle = deferred.trim().toLowerCase();
    const list = needle
      ? apps.filter(
          (app) => app.name.toLowerCase().includes(needle) || app.id.toLowerCase().includes(needle),
        )
      : apps;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [apps, deferred]);
  const shown = filtered.slice(0, RENDER_LIMIT);
  return (
    <>
      <label className={styles.search}>
        <Icon name="search" size={14} />
        <input
          type="search"
          value={query}
          aria-label={t("computerUse.picker.search")}
          placeholder={t("computerUse.picker.search")}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <fieldset className={styles.appList} aria-label={label}>
        {shown.map((app) => (
          <label key={app.id} className={styles.appRow} data-locked={app.locked ? true : undefined}>
            <input
              type="checkbox"
              checked={checked(app.id)}
              disabled={disabled || !!app.locked}
              onChange={(event) =>
                toggle({ id: app.id, name: app.name }, event.currentTarget.checked)
              }
            />
            <span className={styles.appName}>{app.name}</span>
            {app.locked ? (
              <span className={styles.hint} data-tone="danger">
                {app.locked}
              </span>
            ) : (
              app.hint && <span className={styles.hint}>{app.hint}</span>
            )}
          </label>
        ))}
        {!shown.length && <p className={styles.listNote}>{t("computerUse.picker.noMatch")}</p>}
      </fieldset>
      {filtered.length > shown.length && (
        <p className={styles.listNote}>
          {t("computerUse.picker.more", { count: filtered.length - shown.length })}
        </p>
      )}
    </>
  );
}
