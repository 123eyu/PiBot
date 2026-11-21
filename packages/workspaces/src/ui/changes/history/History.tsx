import type { ChatPeer } from "@pibot/client-core";
import { useSettings } from "@pibot/renderer-kit";
import type { ChangeCommit } from "@pibot/workspaces-contract/full";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "../changes.module.css";
import { pluralCount } from "../diff/FileList.tsx";
import { ChangesIcon } from "../icons.tsx";
import type { ChangesTarget } from "../store.ts";

export const shortOid = (oid: string) => oid.slice(0, 7);

export function commitTime(time: string, language: string) {
  const date = new Date(time);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit", hour12: false })
    : date.toLocaleDateString(language, { month: "short", day: "numeric", year: "numeric" });
}

/** The 50 most recent commits (view only); a "changes.changed" bumps `revision`. */
export function History({
  peer,
  target,
  revision,
  open,
}: {
  peer: ChatPeer;
  target: ChangesTarget;
  revision: string;
  open(commit: ChangeCommit): void;
}) {
  const { t, language } = useSettings();
  const [commits, setCommits] = useState<ChangeCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const key = JSON.stringify(target);
  const load = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true);
    setError(false);
    try {
      const page = await peer.call(
        "changes.log",
        { ...(JSON.parse(key) as ChangesTarget), limit: 50 },
        { timeoutMs: 30_000 },
      );
      if (version !== generation.current) return;
      setCommits(page.commits);
    } catch {
      if (version === generation.current) setError(true);
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [peer, key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision re-reads after a change event
  useEffect(() => {
    void load();
  }, [load, revision]);
  return (
    <div className={styles.history}>
      {commits.map((commit) => (
        <button
          key={commit.oid}
          type="button"
          className={styles.commit}
          onClick={() => open(commit)}
        >
          {/* A neutral initial, not a photo: no avatar service is contacted (no telemetry). */}
          <span className={styles.commitInitial} aria-hidden="true">
            {Array.from(commit.author.trim())[0]?.toUpperCase() ?? "?"}
          </span>
          <span className={styles.commitMain}>
            <span className={styles.commitSubject}>{commit.subject || shortOid(commit.oid)}</span>
            <span className={styles.commitMeta}>
              <span className={styles.mono}>{shortOid(commit.oid)}</span> · {commit.author} ·{" "}
              {commitTime(commit.time, language)}
              {typeof commit.files === "number" &&
                ` · ${t("changes.history.files", { count: pluralCount(commit.files) })}`}
            </span>
          </span>
          <ChangesIcon name="right" />
        </button>
      ))}
      {loading && (
        <div className={styles.skeleton} role="status" aria-label={t("common.loading")}>
          <i style={{ width: "70%" }} />
          <i style={{ width: "55%" }} />
        </div>
      )}
      {error && (
        <div className={styles.bannerInfo} role="alert">
          <span>{t("changes.history.error")}</span>
          <button type="button" className={styles.miniAccent} onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </div>
      )}
      {!loading && !error && !commits.length && (
        <p className={styles.listEmpty}>{t("changes.history.empty")}</p>
      )}
      <p className={styles.footNote}>{t("changes.history.note")}</p>
    </div>
  );
}
