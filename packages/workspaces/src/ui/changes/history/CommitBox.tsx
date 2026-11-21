import type { TranslationKey } from "@pibot/i18n";
import { useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import type { GitIdentity } from "@pibot/workspaces-contract/full";
import { useState } from "react";
import { GitInstallCard } from "../../git/GitInstallCard.tsx";
import styles from "../changes.module.css";
import { formatCount } from "../diff/FileList.tsx";
import { ChangesIcon } from "../icons.tsx";
import { changesErrorKey } from "../model.ts";

/** The commit button always stays at the bottom of the sidebar. */
export function CommitBox({
  botName,
  selected,
  total,
  authorMissing,
  writesIsolated,
  draft,
  commit,
}: {
  botName: string;
  selected: number;
  total: number;
  authorMissing: boolean;
  writesIsolated: boolean;
  draft(signal: AbortSignal): Promise<string>;
  commit(message: string, author?: GitIdentity): Promise<void>;
}) {
  const t = useT();
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [drafting, setDrafting] = useState<AbortController>();
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<TranslationKey>();
  const author = authorMissing ? { name: name.trim(), email: email.trim() } : undefined;
  const ready =
    !!message.trim() &&
    selected > 0 &&
    !committing &&
    (!author || (!!author.name && !!author.email));
  return (
    <div className={styles.commitBox}>
      <label className={styles.visuallyHidden} htmlFor="changes-commit-message">
        {t("changes.commit.message")}
      </label>
      <textarea
        id="changes-commit-message"
        className={styles.textarea}
        rows={message ? 4 : 1}
        maxLength={10_000}
        placeholder={t("changes.commit.placeholder")}
        value={message}
        disabled={committing}
        onChange={(event) => setMessage(event.currentTarget.value)}
      />
      {authorMissing && (
        <div className={styles.authorRow}>
          <span>{t("changes.commit.authorMissing")}</span>
          <input
            className={styles.input}
            aria-label={t("changes.commit.authorName")}
            placeholder={t("changes.commit.authorName")}
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <input
            className={styles.input}
            type="email"
            aria-label={t("changes.commit.authorEmail")}
            placeholder={t("changes.commit.authorEmail")}
            value={email}
            maxLength={320}
            onChange={(event) => setEmail(event.currentTarget.value)}
          />
        </div>
      )}
      <div className={styles.commitRow}>
        <button
          type="button"
          className={styles.mini}
          disabled={committing || selected === 0}
          onClick={async () => {
            if (drafting) {
              drafting.abort();
              setDrafting(undefined);
              return;
            }
            const abort = new AbortController();
            setDrafting(abort);
            setError(undefined);
            try {
              const text = await draft(abort.signal);
              if (!abort.signal.aborted) setMessage(text);
            } catch (failure) {
              if (!abort.signal.aborted) setError(changesErrorKey(failure));
            } finally {
              setDrafting((current) => (current === abort ? undefined : current));
            }
          }}
        >
          {drafting ? (
            <>
              <span className={styles.spin} aria-hidden="true" />
              {t("changes.commit.drafting")}
            </>
          ) : (
            <>
              <ChangesIcon name="sparkle" />
              {t("changes.commit.draft", { name: botName })}
            </>
          )}
        </button>
        <span className={styles.selection}>
          {selected === total
            ? t("changes.commit.all", { count: formatCount(total) })
            : t("changes.commit.some", { count: formatCount(selected), total: formatCount(total) })}
        </span>
        <Button
          className={styles.smallPrimary}
          disabled={!ready}
          loading={committing}
          onClick={async () => {
            setCommitting(true);
            setError(undefined);
            try {
              await commit(message.trim(), author);
              setMessage("");
            } catch (failure) {
              setError(changesErrorKey(failure));
            } finally {
              setCommitting(false);
            }
          }}
        >
          {t("changes.commit.submit")}
        </Button>
      </div>
      {error && (
        <p className={styles.errorText} role="alert">
          {t(error)}
        </p>
      )}
      {error === "changes.error.changes_git_unavailable" && <GitInstallCard context="changes" />}
      <p className={styles.footNote}>
        {t("changes.commit.hooks")}
        {!writesIsolated && ` ${t("changes.commit.notIsolated")}`}
      </p>
    </div>
  );
}
