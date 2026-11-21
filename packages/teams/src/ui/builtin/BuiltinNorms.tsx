import type { Bot, MethodParams } from "@pibot/protocol";
import { useSettings, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "./builtin.module.css";
import { useBuiltinCatalog } from "./shared.tsx";

/** Norms are opt-in content, not a role/permission or skill-package upgrade. */
export function BuiltinNorms({
  bot,
  busy,
  save,
}: {
  bot: Bot;
  busy: boolean;
  save(patch: Omit<MethodParams["bots.update"], "botId">): Promise<boolean>;
}) {
  const t = useT();
  const { language } = useSettings();
  const { catalog, error, reload } = useBuiltinCatalog();
  const role = catalog?.roles.find((item) => item.id === bot.role?.id);
  const [preview, setPreview] = useState<{ current: string; next: string; version: number }>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const locked = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  if (bot.category !== "chat" || !bot.role) return null;
  if (error)
    return (
      <p className={styles.note} role="alert">
        {t("builtin.role.loadFailed")}{" "}
        <Button variant="ghost" onClick={reload}>
          {t("common.retry")}
        </Button>
      </p>
    );
  if (role?.botCategory !== "chat" || catalog?.language !== language) return null;
  // While a newer role version exists,「采用新版」(BuiltinUpdate) covers the norms too.
  if (role.version > (bot.role.version ?? 0)) return null;
  const current = bot.norms ?? "";
  const stale =
    !!preview &&
    (preview.current !== current ||
      preview.next !== role.norms ||
      preview.version !== role.version);
  const showPreview = () => {
    setFailed(false);
    setPreview({ current, next: role.norms, version: role.version });
  };
  const apply = async () => {
    if (!preview || stale || busy || locked.current) return;
    locked.current = true;
    setPending(true);
    setFailed(false);
    try {
      const saved = await save({ norms: preview.next, expectedNorms: preview.current });
      if (!active.current) return;
      if (saved) setPreview(undefined);
      else setFailed(true);
    } catch {
      // The server may have saved before a transport failure; refresh before retrying.
      if (active.current) setFailed(true);
    } finally {
      locked.current = false;
      if (active.current) setPending(false);
    }
  };
  return (
    <section className={styles.stack} aria-label={t("builtin.profile.compareNorms")}>
      {current === role.norms && !preview ? (
        <p className={styles.note}>{t("builtin.profile.normsCurrent")}</p>
      ) : (
        <div>
          <Button variant="ghost" disabled={busy || pending} onClick={showPreview}>
            {t("builtin.profile.compareNorms")}
          </Button>
        </div>
      )}
      {preview && (
        <div className={styles.card}>
          <p className={styles.note}>{t("builtin.profile.normsReplaceHint")}</p>
          <h3 className={styles.subheading}>{t("builtin.profile.currentNorms")}</h3>
          <div className={`${styles.pre} ${styles.normsPreview}`}>
            {preview.current || t("builtin.profile.emptyNorms")}
          </div>
          <h3 className={styles.subheading}>
            {t("builtin.profile.newNorms", { version: preview.version })}
          </h3>
          <div className={`${styles.pre} ${styles.normsPreview}`}>{preview.next}</div>
          {stale && (
            <p role="status" className={styles.warn}>
              {t("builtin.profile.normsChanged")}
            </p>
          )}
          {failed && (
            <p role="alert" className={styles.error}>
              {t("builtin.profile.normsSaveFailed")}
            </p>
          )}
          <div className={styles.actions}>
            <Button variant="pill" disabled={busy || pending || stale} onClick={() => void apply()}>
              {t("builtin.profile.adoptNorms")}
            </Button>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setPreview(undefined);
                setFailed(false);
              }}
            >
              {t("builtin.profile.keepNorms")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
