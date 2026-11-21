import type { MethodResults } from "@pibot/protocol";
import { useRpc, useT } from "@pibot/renderer-kit";
import { Button, Chip, Logo, TextField } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "./app-menu.module.css";

export async function openWebsite(
  peer: ReturnType<typeof useRpc>["peer"],
  url = "https://pibot.space",
) {
  if (!peer) throw new Error("app_offline");
  await peer.call("app.openLink", { url });
}
export function AboutPanel() {
  const t = useT(),
    { peer } = useRpc();
  const [data, setData] = useState<{
    info: MethodResults["app.getInfo"];
    dependencies: MethodResults["app.dependencies"];
  }>();
  const [error, setError] = useState(false),
    [attempt, setAttempt] = useState(0),
    [search, setSearch] = useState(""),
    [limit, setLimit] = useState(60);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly starts a fresh request.
  useEffect(() => {
    let alive = true;
    setError(false);
    if (!peer) setError(true);
    if (peer)
      void Promise.all([
        peer.call("app.getInfo", undefined),
        peer.call("app.dependencies", undefined),
      ]).then(
        ([info, dependencies]) => {
          if (alive) setData({ info, dependencies });
        },
        () => {
          if (alive) setError(true);
        },
      );
    return () => {
      alive = false;
    };
  }, [peer, attempt]);
  const filtered =
    data?.dependencies.filter((d) =>
      `${d.name} ${d.version} ${d.license}`.toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  return (
    <>
      <div className={styles.brand}>
        <Logo size={76} />
        <h2>{t("appMenu.productName")}</h2>
        <p className={styles.note}>
          {data
            ? `v${data.info.version.split(":")[0]}${typeof __PIBOT_COMMIT__ !== "undefined" && __PIBOT_COMMIT__ ? ` · ${__PIBOT_COMMIT__.slice(0, 8)}` : ""} · pi ${data.info.piVersion}`
            : t("common.loading")}
        </p>
      </div>
      {error && (
        <p role="alert" className={styles.error}>
          {t("workspace.failed")}{" "}
          <Button variant="ghost" onClick={() => setAttempt((n) => n + 1)}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {data && (
        <details className={styles.dependencies}>
          <summary>{t("appMenu.dependencies", { count: data.dependencies.length })}</summary>
          <input
            type="search"
            aria-label={t("appMenu.searchDependencies")}
            placeholder={t("appMenu.searchDependencies")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setLimit(60);
            }}
          />
          {!data.dependencies.length && (
            <p className={styles.note}>{t("appMenu.dependenciesUnavailable")}</p>
          )}
          {!!data.dependencies.length && !filtered.length && (
            <p role="status" className={styles.note}>
              {t("combobox.noResults")}
            </p>
          )}
          <ul>
            {filtered.slice(0, limit).map((d) => (
              <li key={`${d.name}@${d.version}`}>
                <strong>{d.name}</strong>
                <span>{d.version}</span>
                <Chip>{d.license}</Chip>
              </li>
            ))}
          </ul>
          {filtered.length > limit && (
            <Button variant="ghost" onClick={() => setLimit((n) => n + 60)}>
              {t("workspace.more")}
            </Button>
          )}
        </details>
      )}
    </>
  );
}
export function FeedbackPanel() {
  const t = useT(),
    { peer } = useRpc();
  // The public repository; the person can still point feedback at a fork.
  const [repository, setRepository] = useState("w01fb0ss/PiBot");
  const [title, setTitle] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [text, setText] = useState(""),
    [status, setStatus] = useState<string>(),
    [busy, setBusy] = useState(false);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const locked = useRef(false);
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => lifetime.current?.abort();
  }, []);
  const perform = async (action: (signal: AbortSignal) => Promise<string>) => {
    if (locked.current || !lifetime.current) return;
    locked.current = true;
    const signal = lifetime.current.signal;
    setBusy(true);
    setStatus(undefined);
    try {
      const result = await action(signal);
      if (!signal.aborted) setStatus(result);
    } catch {
      if (!signal.aborted) setStatus(t("workspace.failed"));
    } finally {
      locked.current = false;
      if (!signal.aborted) setBusy(false);
    }
  };
  return (
    <>
      <div className={styles.feedbackForm}>
        <label className={styles.feedbackField}>
          <span className={styles.feedbackLabel}>{t("appMenu.problem")}</span>
          <textarea
            rows={5}
            disabled={busy}
            maxLength={12000}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setConfirming(false);
            }}
            placeholder={t("appMenu.problemHint")}
          />
        </label>
        <TextField
          label={t("appMenu.feedbackTitle")}
          value={title}
          disabled={busy}
          maxLength={200}
          onChange={(event) => {
            setTitle(event.target.value);
            setConfirming(false);
          }}
        />
        <TextField
          label={t("appMenu.feedbackRepository")}
          description={t("appMenu.feedbackNote")}
          value={repository}
          disabled={busy}
          maxLength={200}
          placeholder="owner/repository"
          spellCheck={false}
          onChange={(event) => {
            setRepository(event.target.value);
            setConfirming(false);
          }}
        />
      </div>
      <p className={`${styles.note} ${styles.feedbackPrivacy}`}>{t("appMenu.feedbackPrivacy")}</p>
      {confirming && <p className={styles.note}>{t("appMenu.feedbackConfirm", { repository })}</p>}
      <div className={styles.feedbackActions}>
        <Button
          variant="primary"
          disabled={
            busy ||
            !peer ||
            !title.trim() ||
            !text.trim() ||
            !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(repository)
          }
          onClick={() => {
            if (!confirming) {
              setConfirming(true);
              return;
            }
            void perform(async (signal) => {
              if (!peer) throw new Error("app_offline");
              await peer.call(
                "app.openFeedback",
                { repository, title: title.trim(), description: text.trim(), confirmed: true },
                { signal, timeoutMs: 20_000 },
              );
              if (!signal.aborted) setConfirming(false);
              return t("appMenu.feedbackOpened");
            });
          }}
        >
          {t(confirming ? "appMenu.feedbackOpenConfirmed" : "appMenu.feedbackOpen")}
        </Button>
        <Button
          variant="secondary"
          disabled={busy || !text.trim() || !peer}
          onClick={() =>
            void perform(async () => {
              if (!peer) throw new Error("app_offline");
              const info = await peer.call("app.getInfo", undefined);
              await navigator.clipboard.writeText(
                `PiBot v${info.version.split(":")[0]} · ${info.platform}\n${title.trim()}\n\n${text.trim()}`,
              );
              return t("appMenu.copied");
            })
          }
        >
          {t("appMenu.copyFeedback")}
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const result = await window.pibot.exportLogs();
              if (result === "failed") throw new Error("log_export_failed");
              return t(result === "saved" ? "settings.logsExported" : "setup.logsCanceled");
            })
          }
        >
          {t("settings.exportLogs")}
        </Button>
      </div>
      {status && (
        <p role="status" className={styles.note}>
          {status}
        </p>
      )}
    </>
  );
}
