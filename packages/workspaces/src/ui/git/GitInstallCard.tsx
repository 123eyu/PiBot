import type { TranslationKey } from "@pibot/i18n";
import { approvalStyles, useRpc, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import type { GitSetupStatus } from "@pibot/workspaces-contract";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import styles from "./git-install.module.css";

const POLL_MS = 3000;
const MARK = "\u0001";

function BranchIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 7v10M18 10c0 4-6 3-12 7" />
    </svg>
  );
}

/** A translated sentence with its {command} shown as code. */
function WithCommand({ text, command }: { text: string; command: string }) {
  const [before, after] = text.split(MARK);
  return (
    <>
      {before}
      <code className={styles.code}>{command}</code>
      {after}
    </>
  );
}

/**
 * 「Pi Bot 需要安装 Git」 (maintainers 2026-11-21), shown only where a feature just needed Git: a
 * group plan whose parallel steps had to take turns ("parallel") and the changes panel or its
 * commit ("changes"). macOS and Linux only; on Windows (Git ships with Pi Bot) the brain answers
 * "unsupported" and `fallback` renders instead. The click on 「安装」 is the confirmation.
 */
export function GitInstallCard({
  context,
  onInstalled,
  fallback = null,
}: {
  context: "parallel" | "changes";
  onInstalled?: () => void;
  fallback?: ReactNode;
}) {
  const t = useT();
  const { peer } = useRpc();
  const [status, setStatus] = useState<GitSetupStatus>();
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const watched = useRef(false);
  const announced = useRef(false);
  const installed = useRef(onInstalled);
  installed.current = onInstalled;

  const read = useCallback(
    async (signal?: AbortSignal) => {
      if (!peer) return;
      const next = await peer.call("changes.gitStatus", {}, { timeoutMs: 20_000, signal });
      if (!signal?.aborted) setStatus(next);
    },
    [peer],
  );
  useEffect(() => {
    const abort = new AbortController();
    read(abort.signal).catch(() => {
      // Without an answer the card stays hidden; the feature's own message still explains.
    });
    return () => abort.abort();
  }, [read]);
  const state = status?.state;
  useEffect(() => {
    if (state !== "installing") return;
    watched.current = true;
    const abort = new AbortController();
    const timer = setInterval(() => {
      read(abort.signal).catch(() => {
        // A missed poll is retried on the next tick.
      });
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      abort.abort();
    };
  }, [state, read]);
  useEffect(() => {
    if (state !== "available" || announced.current) return;
    announced.current = true;
    installed.current?.();
  }, [state]);

  const act = async (method: "changes.gitInstall" | "changes.gitStatus") => {
    if (!peer || busy) return;
    setBusy(true);
    setError(false);
    try {
      setStatus(await peer.call(method, {}, { timeoutMs: 20_000 }));
      if (method === "changes.gitInstall") watched.current = true;
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;
  if (status.state === "unsupported") return <>{fallback}</>;
  const parallel = context === "parallel";
  if (status.state === "available") {
    // The changes panel only confirms an install it watched; a plan's card keeps its outcome.
    if (!parallel && !watched.current) return null;
    const key: TranslationKey = status.version
      ? parallel
        ? "changes.git.installed"
        : "changes.git.installedPlain"
      : parallel
        ? "changes.git.installedNoVersion"
        : "changes.git.installedPlainNoVersion";
    return (
      <p className={styles.state} data-tone="ok" role="status">
        <span className={styles.dot} aria-hidden="true" />
        {t(key, { version: status.version ?? "" })}
      </p>
    );
  }
  if (status.state === "installing")
    return (
      <p className={styles.state} role="status">
        <span className={styles.dot} aria-hidden="true" />
        {t(parallel ? "changes.git.installing" : "changes.git.installingPlain")}
        {status.installer === "xcode" && (
          <span className={styles.hint}>{t("changes.git.installingMac")}</span>
        )}
      </p>
    );
  if (status.state === "failed")
    return (
      <p className={styles.state} data-tone="danger" role="alert">
        <span className={styles.dot} aria-hidden="true" />
        <span>
          {status.manualCommand ? (
            <WithCommand
              text={t("changes.git.failed", { command: MARK })}
              command={status.manualCommand}
            />
          ) : (
            t("changes.git.failedGeneric")
          )}
        </span>
        <Button
          variant="secondary"
          className={styles.recheck}
          loading={busy}
          onClick={() => void act("changes.gitStatus")}
        >
          {t("changes.git.recheck")}
        </Button>
      </p>
    );
  if (dismissed) return null;
  const what =
    status.installer === "xcode" ? (
      t("changes.git.whatMac")
    ) : status.installer === "package" && status.command ? (
      <WithCommand text={t("changes.git.whatLinux", { command: MARK })} command={status.command} />
    ) : (
      t("changes.git.whatLinuxGeneric")
    );
  return (
    <section
      className={`${approvalStyles.approval} ${styles.card}`}
      data-tone="violet"
      aria-label={t("changes.git.title")}
    >
      <header>
        <span aria-hidden="true">
          <BranchIcon />
        </span>
        <strong>{t("changes.git.title")}</strong>
      </header>
      <dl className={approvalStyles.facts}>
        <div>
          <dt>{t("changes.git.why")}</dt>
          <dd>{t(parallel ? "changes.git.whyParallel" : "changes.git.whyChanges")}</dd>
        </div>
        <div>
          <dt>{t("changes.git.what")}</dt>
          <dd>{what}</dd>
        </div>
        <div>
          <dt>{t("changes.git.where")}</dt>
          <dd>{t("changes.git.whereValue")}</dd>
        </div>
      </dl>
      <p className={approvalStyles.warning}>{t("changes.git.note")}</p>
      <footer>
        {error && (
          <p role="alert" className={approvalStyles.risk}>
            {t("changes.git.error")}
          </p>
        )}
        <div className={approvalStyles.actions}>
          <Button variant="secondary" disabled={busy} onClick={() => setDismissed(true)}>
            {t(parallel ? "changes.git.later" : "changes.git.laterPlain")}
          </Button>
          <Button loading={busy} disabled={!peer} onClick={() => void act("changes.gitInstall")}>
            {t("changes.git.install")}
          </Button>
        </div>
      </footer>
    </section>
  );
}
