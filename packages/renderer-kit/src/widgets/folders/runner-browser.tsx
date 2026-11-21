import type { TranslationKey } from "@pibot/i18n";
import type { RunnerBrowse } from "@pibot/protocol";
import { Icon, IconTile } from "@pibot/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../../settings/context.ts";
import styles from "./folders.module.css";
import type { RunnerEntry } from "./runner-folders.ts";
import { folderError } from "./selection.ts";

/**
 * Browse a runner's folders one level at a time and pick one, the way the system dialog
 * browses this computer — never a typed path. `fixed` keeps it on one runner (a read-only
 * reference must be on the primary folder's device).
 */
export function RunnerFolderBrowser({
  runners,
  runner: initial,
  fixed,
  browse,
  locked,
  onPick,
  onBack,
}: {
  runners: RunnerEntry[];
  runner: string;
  fixed?: boolean;
  browse(
    location: string,
    path: string | null | undefined,
    signal: AbortSignal,
  ): Promise<RunnerBrowse>;
  locked: boolean;
  onPick(location: string, path: string): void;
  onBack(): void;
}) {
  const t = useT();
  const [runner, setRunner] = useState(initial);
  const [level, setLevel] = useState<RunnerBrowse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<TranslationKey>();
  const reading = useRef<AbortController | undefined>(undefined);
  // The owner rebuilds its model on every change; only a new runner restarts the browsing.
  const browseRef = useRef(browse);
  browseRef.current = browse;
  const load = useCallback(
    (path: string | null | undefined) => {
      reading.current?.abort();
      const controller = new AbortController();
      reading.current = controller;
      setLoading(true);
      setError(undefined);
      browseRef
        .current(runner, path, controller.signal)
        .then((next) => {
          if (!controller.signal.aborted) setLevel(next);
        })
        .catch((failure: unknown) => {
          if (!controller.signal.aborted) setError(folderError(failure));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    },
    [runner],
  );
  useEffect(() => {
    setLevel(undefined);
    load(undefined);
  }, [load]);
  useEffect(() => () => reading.current?.abort(), []);
  const current = runners.find((entry) => entry.id === runner);
  const up = level && !level.top ? level.parent : undefined;
  return (
    <div className={styles.browser}>
      <button type="button" className={styles.item} onClick={onBack}>
        <IconTile icon="back" tone="neutral" size="sm" />
        <span className={styles.itemText}>{t("remote.runner.back")}</span>
      </button>
      <p className={styles.heading}>{t("remote.runner.folder")}</p>
      {!fixed && runners.length > 1 && (
        <div className={styles.runnerTabs}>
          {runners.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={styles.mini}
              aria-pressed={entry.id === runner}
              disabled={!entry.online || locked}
              onClick={() => setRunner(entry.id)}
            >
              {entry.online ? entry.name : t("remote.runner.offlineName", { name: entry.name })}
            </button>
          ))}
        </div>
      )}
      <p className={styles.crumb} title={level?.path ?? undefined}>
        {current?.name ?? t("remote.runner.kind")} · {level?.path ?? t("remote.runner.drives")}
      </p>
      {error && (
        <p className={styles.notice} role="alert">
          {t(error)}
        </p>
      )}
      {loading && !error && (
        <p className={styles.notice} role="status">
          {t("remote.runner.reading")}
        </p>
      )}
      <ul className={styles.rows} aria-busy={loading}>
        {up !== undefined && (
          <li>
            <button
              type="button"
              className={styles.item}
              disabled={loading}
              onClick={() => load(up)}
            >
              <IconTile icon="arrow" tone="neutral" size="sm" className={styles.upIcon} />
              <span className={styles.itemText}>{t("remote.runner.up")}</span>
            </button>
          </li>
        )}
        {level?.folders.map((folder) => (
          <li key={folder.path}>
            <button
              type="button"
              className={styles.item}
              disabled={loading}
              title={folder.path}
              onClick={() => load(folder.path)}
            >
              <IconTile icon="folder" tone="amber" size="sm" />
              <span className={styles.itemText}>{folder.name}</span>
              <Icon name="chevronRight" size={13} className={styles.check} />
            </button>
          </li>
        ))}
      </ul>
      {level && !level.folders.length && !loading && (
        <p className={styles.foot}>{t("remote.runner.noFolders")}</p>
      )}
      {level?.truncated && <p className={styles.foot}>{t("remote.runner.truncated")}</p>}
      <div className={styles.group}>
        <button
          type="button"
          className={`${styles.item} ${styles.use}`}
          disabled={locked || loading || !level?.path}
          onClick={() => level?.path && onPick(runner, level.path)}
        >
          <IconTile icon="check" tone="green" size="sm" />
          <span className={styles.itemText}>
            {t("remote.runner.useThis", {
              name: level?.path ? level.path : t("remote.runner.drives"),
            })}
          </span>
        </button>
      </div>
    </div>
  );
}
