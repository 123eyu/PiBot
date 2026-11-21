import type { TranslationKey } from "@pibot/i18n";
import { type BuiltinChange, type BuiltinUpdatePreview, RpcError } from "@pibot/protocol";
import { useRpc, useRpcEvent, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./builtin.module.css";

type Target = { botId: string } | { groupId: string };
type T = ReturnType<typeof useT>;

function level(t: T, value: string | undefined) {
  if (value === "never" || value === "ask" || value === "always")
    return t(`permissions.level.${value}`);
  return t("builtin.update.default");
}
function thinking(t: T, value: string | undefined) {
  return value === "off" || value === "low" || value === "medium" || value === "high"
    ? t(`models.thinking.${value}`)
    : (value ?? "");
}

/** One preview line in the UI language; names come from the files, never free text. */
export function changeLine(t: T, line: BuiltinChange): string {
  const name = line.name ?? "";
  const text = (() => {
    switch (line.item) {
      case "norms":
        return t("builtin.update.line.norms");
      case "thinking":
        return t("builtin.update.line.thinking", {
          from: thinking(t, line.from),
          to: thinking(t, line.to),
        });
      case "permission":
        return t("builtin.update.line.permission", {
          category: line.category ? t(`permissions.category.${line.category}`) : "",
          from: level(t, line.from),
          to: level(t, line.to),
        });
      case "skill":
        return t(
          line.action === "add"
            ? "builtin.update.line.skillAdd"
            : line.action === "update"
              ? "builtin.update.line.skillUpdate"
              : line.action === "remove"
                ? "builtin.update.line.skillRemove"
                : "builtin.update.line.skill",
          { name },
        );
      case "announcement":
        return t("builtin.update.line.announcement");
      case "coordinator":
        return t("builtin.update.line.coordinator", { name });
      case "roundLimit":
        return t("builtin.update.line.roundLimit", { from: line.from ?? "", to: line.to ?? "" });
      case "quickStarts":
      case "member":
        return t("builtin.update.line.member", { name });
    }
  })();
  return line.reason ? `${text} · ${t(`builtin.update.reason.${line.reason}`)}` : text;
}

/**
 * 「有新版本」for a Bot made from a built-in role or a group made from a template: a short
 * diff (what changes, what stays because the user changed it), then「采用新版」or「保留当前」.
 * Everything is decided by brain; this only shows the preview and sends its revision back.
 */
export function BuiltinUpdate({ target, disabled }: { target: Target; disabled?: boolean }) {
  const t = useT();
  const { peer } = useRpc();
  const [preview, setPreview] = useState<BuiltinUpdatePreview | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [status, setStatus] = useState<{ key: TranslationKey; count?: number; error?: boolean }>();
  const [revision, setRevision] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const key = "botId" in target ? `bot:${target.botId}` : `group:${target.groupId}`;
  const reload = useCallback(() => {
    clearTimeout(timer.current);
    // Adopting emits several changes at once; refresh after the burst.
    timer.current = setTimeout(() => setRevision((n) => n + 1), 200);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key identifies the target; revision reloads.
  useEffect(() => {
    if (!peer) return;
    let active = true;
    const params: Target =
      "botId" in target ? { botId: target.botId } : { groupId: target.groupId };
    peer
      .call("builtin.update.preview", params)
      .then((value) => {
        if (!active) return;
        setPreview(value);
        setPicked((list) => list.filter((id) => value?.members.some((m) => m.roleId === id)));
      })
      .catch(() => {
        // The panel works without the offer; a later change event retries.
        if (active) setPreview(null);
      });
    return () => {
      active = false;
    };
  }, [peer, key, revision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another Bot or group starts closed.
  useEffect(() => {
    setOpen(false);
    setStatus(undefined);
    setPicked([]);
  }, [key]);
  const mine = (id: string, kind: "bot" | "group") =>
    kind === "bot"
      ? "botId" in target && target.botId === id
      : "groupId" in target && target.groupId === id;
  useRpcEvent("bots.changed", (event) => {
    if (mine(event.botId, "bot")) reload();
  });
  useRpcEvent("groups.changed", (event) => {
    if (mine(event.groupId, "group")) reload();
  });
  useRpcEvent("skills.changed", (event) => {
    if (!event.groupId && mine(event.botId, "bot")) reload();
  });
  if (!preview)
    return status ? (
      <p className={styles.note} role="status">
        {t(status.key)}
      </p>
    ) : null;
  const run = async (action: "apply" | "dismiss") => {
    if (!peer || busy) return;
    setBusy(true);
    setStatus(undefined);
    const base: Target = "botId" in target ? { botId: target.botId } : { groupId: target.groupId };
    try {
      if (action === "dismiss") {
        await peer.call("builtin.update.dismiss", { ...base, version: preview.toVersion });
        setOpen(false);
      } else {
        const result = await peer.call("builtin.update.apply", {
          ...base,
          toVersion: preview.toVersion,
          revision: preview.revision,
          ...(picked.length ? { addMembers: picked } : {}),
        });
        setOpen(false);
        setStatus(
          result.failed.length
            ? { key: "builtin.update.partialDone", count: result.failed.length, error: true }
            : { key: "builtin.update.done" },
        );
      }
    } catch (error) {
      setStatus({
        key:
          error instanceof RpcError && error.message === "builtin_update_changed"
            ? "builtin.update.changed"
            : error instanceof RpcError && error.message === "builtin_coordinator_member_required"
              ? "builtin.update.coordinatorMemberRequired"
              : "builtin.update.failed",
        error: true,
      });
    } finally {
      setBusy(false);
      reload();
    }
  };
  const restore = async () => {
    if (!peer || busy) return;
    setBusy(true);
    setStatus(undefined);
    const base: Target = "botId" in target ? { botId: target.botId } : { groupId: target.groupId };
    try {
      const result = await peer.call("builtin.update.restore", base);
      setStatus(
        result.failed.length
          ? { key: "builtin.update.restorePartial", count: result.failed.length, error: true }
          : { key: "builtin.update.restored" },
      );
    } catch {
      setStatus({ key: "builtin.update.failed", error: true });
    } finally {
      setBusy(false);
      reload();
    }
  };
  // The new version applies on its own. This card now reports that it happened and keeps
  // the only way back (the values the update replaced) one click away.
  if (preview.state === "current")
    return (
      <section className={styles.card} aria-label={t("builtin.update.title")}>
        <div className={styles.actions}>
          <span className={styles.note}>
            {t("builtin.update.autoDone", { name: preview.name, to: preview.toVersion })}
          </span>
          {preview.restorable && (
            <Button variant="ghost" disabled={busy || disabled} onClick={() => void restore()}>
              {t("builtin.update.restore")}
            </Button>
          )}
        </div>
        {status && (
          <p
            role={status.error ? "alert" : "status"}
            className={status.error ? styles.error : styles.note}
          >
            {t(status.key, { count: status.count ?? 0 })}
          </p>
        )}
      </section>
    );
  const title = t(
    preview.fromVersion ? "builtin.update.available" : "builtin.update.availableUnknown",
    {
      name: preview.name,
      from: preview.fromVersion,
      to: preview.toVersion,
    },
  );
  return (
    <section className={styles.card} aria-label={t("builtin.update.title")}>
      {preview.dismissed && !open ? (
        <div className={styles.actions}>
          <span className={styles.note}>
            {t("builtin.update.dismissed", { name: preview.name, to: preview.toVersion })}
          </span>
          <Button variant="ghost" onClick={() => setOpen(true)}>
            {t("builtin.update.view")}
          </Button>
        </div>
      ) : (
        <div className={styles.actions}>
          <strong className={styles.rowText}>{title}</strong>
          <Button variant="ghost" onClick={() => setOpen((value) => !value)}>
            {t(open ? "builtin.update.hide" : "builtin.update.view")}
          </Button>
        </div>
      )}
      {open && (
        <>
          {preview.provenance !== "recorded" && (
            <p className={styles.note}>
              {t(
                preview.provenance === "history"
                  ? "builtin.update.provenanceHistory"
                  : "builtin.update.provenanceNone",
              )}
            </p>
          )}
          {preview.changes.length > 0 ? (
            <>
              <h3 className={styles.subheading}>{t("builtin.update.changes")}</h3>
              <ul className={styles.list}>
                {preview.changes.map((line, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines are a fixed snapshot of one preview.
                  <li key={index}>{changeLine(t, line)}</li>
                ))}
              </ul>
            </>
          ) : (
            !preview.members.length && <p className={styles.note}>{t("builtin.update.nothing")}</p>
          )}
          {preview.kept.length > 0 && (
            <>
              <h3 className={styles.subheading}>{t("builtin.update.kept")}</h3>
              <ul className={styles.list}>
                {preview.kept.map((line, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines are a fixed snapshot of one preview.
                  <li key={index}>{changeLine(t, line)}</li>
                ))}
              </ul>
            </>
          )}
          {preview.members.length > 0 && (
            <>
              <h3 className={styles.subheading}>{t("builtin.update.members")}</h3>
              {preview.members.map((member) => (
                <label key={member.roleId} className={styles.row}>
                  <input
                    type="checkbox"
                    className={styles.check}
                    checked={picked.includes(member.roleId)}
                    disabled={busy || disabled}
                    onChange={(event) => {
                      const on = event.currentTarget.checked;
                      setPicked((list) =>
                        on ? [...list, member.roleId] : list.filter((id) => id !== member.roleId),
                      );
                    }}
                  />
                  <span className={styles.rowText}>
                    {member.existingBotName
                      ? t("builtin.update.memberReuse", {
                          name: member.name,
                          bot: member.existingBotName,
                        })
                      : t("builtin.update.memberNew", { name: member.name })}
                  </span>
                </label>
              ))}
            </>
          )}
          {preview.quickStarts.length > 0 && (
            <>
              <p className={styles.note}>{t("builtin.update.quickStarts")}</p>
              <ul className={styles.list}>
                {preview.quickStarts.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )}
          <p className={styles.note}>
            {t(preview.kind === "bot" ? "builtin.update.fixedBot" : "builtin.update.fixedGroup")}
          </p>
          <div className={styles.actions}>
            <Button variant="pill" disabled={busy || disabled} onClick={() => void run("apply")}>
              {t("builtin.update.adopt")}
            </Button>
            {!preview.dismissed && (
              <Button
                variant="ghost"
                disabled={busy || disabled}
                onClick={() => void run("dismiss")}
              >
                {t("builtin.update.keep")}
              </Button>
            )}
          </div>
        </>
      )}
      {status && (
        <p
          role={status.error ? "alert" : "status"}
          className={status.error ? styles.error : styles.note}
        >
          {t(status.key, { count: status.count ?? 0 })}
        </p>
      )}
    </section>
  );
}
