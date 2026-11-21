import type { ComputerPermissions } from "@pibot/computer-use-contract/full";
import {
  hostPlatform,
  SettingsLine,
  SettingsRow,
  SettingsSection,
  useRpc,
  useT,
} from "@pibot/renderer-kit";
import { Button, Chip, type IconName, IconTile, type Tone } from "@pibot/ui";
import { useCallback, useEffect, useState } from "react";
import styles from "../computer.module.css";
import { computerErrorKey } from "../presentation.ts";

type Item = ComputerPermissions["items"][number];
/** Each system permission keeps its own mark (gaps: g-computer). */
const LOOK: Record<string, [IconName, Tone]> = {
  accessibility: ["hand", "pink"],
  screen: ["image", "violet"],
  automation: ["bolt", "blue"],
};
const missing = (item: Item) => item.status === "denied" || item.status === "not_determined";

/** Re-reads when the window regains focus, i.e. after the user comes back from System Settings. */
export function useSystemPermissions(enabled = true) {
  const { peer } = useRpc();
  const [data, setData] = useState<ComputerPermissions>();
  const [error, setError] = useState<ReturnType<typeof computerErrorKey>>();
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(false);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((n) => n + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit reread trigger
  useEffect(() => {
    if (!peer || !enabled) return;
    let active = true;
    peer
      .call("computer.permissions", undefined)
      .then((result) => {
        if (!active) return;
        setData(result);
        setError(undefined);
      })
      .catch((e: unknown) => {
        if (active) setError(computerErrorKey(e));
      });
    return () => {
      active = false;
    };
  }, [peer, enabled, revision]);
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener("focus", reload);
    return () => window.removeEventListener("focus", reload);
  }, [enabled, reload]);
  const open = async (pane: Item["kind"]) => {
    if (!peer || opening) return;
    setOpening(true);
    setOpenError(false);
    try {
      await peer.call("computer.openSystemSettings", { pane });
    } catch {
      setOpenError(true);
    } finally {
      setOpening(false);
    }
  };
  return { data, error, reload, open, opening, openError, connected: !!peer };
}

const statusTone = (item: Item) =>
  item.status === "granted" || item.status === "not_required"
    ? "ok"
    : missing(item)
      ? "danger"
      : undefined;

function StatusTag({ item }: { item: Item }) {
  const t = useT();
  const tone = statusTone(item);
  return (
    <span className={styles.tag} data-tone={tone}>
      {t(`computerUse.permissionStatus.${item.status}`)}
    </span>
  );
}

/**
 * Inside the grant card (compact): only shown on macOS when Accessibility or Screen Recording is
 * missing, so the user can fix it before allowing. Automation cannot be read silently.
 */
export function SystemPermissionRows({
  compact = false,
  onboarding,
}: {
  compact?: boolean;
  onboarding?: { onReady(ready: boolean): void };
}) {
  const t = useT();
  const state = useSystemPermissions();
  // Also needed by the compact card's wording, which differs per platform.
  const platform = state.data?.platform ?? hostPlatform() ?? "unknown";
  // Maintainers 2026-11-13: onboarding shows all three macOS grants, Automation included. Elsewhere
  // Automation is always "not needed" and its text names System Events and Finder, which only
  // misleads on Windows and Linux (v0.0.2 Linux test).
  const items = (state.data?.items ?? []).filter(
    (item) => platform === "darwin" || item.kind !== "automation",
  );
  const onReady = onboarding?.onReady;
  useEffect(() => {
    const data = state.data;
    const ready =
      !!data &&
      !state.error &&
      (data.platform === "darwin"
        ? ["accessibility", "screen"].every((kind) =>
            data.items.some((item) => item.kind === kind && item.status === "granted"),
          ) && !data.items.some((item) => item.kind === "automation" && missing(item))
        : data.available &&
          data.items.every((item) => item.status === "granted" || item.status === "not_required"));
    onReady?.(ready);
  }, [state.data, state.error, onReady]);
  if (compact) {
    const needed = items.filter((item) => item.kind !== "automation" && missing(item));
    if (!needed.length) return null;
    return (
      <>
        {/* The note explains macOS' manual System Settings step; on Windows and Linux the same
            rows appear (Wayland limits, denied access) and the macOS wording would mislead. */}
        {platform === "darwin" && (
          <p className={styles.cardWarn}>{t("computerUse.system.cardNote")}</p>
        )}
        {needed.map((item) => (
          <div key={item.kind} className={styles.permRow}>
            <IconTile
              icon={LOOK[item.kind]?.[0] ?? "shield"}
              tone={LOOK[item.kind]?.[1] ?? "pink"}
              size="sm"
              className={styles.chatTile}
            />
            <span className={styles.permLabel}>{t(`computerUse.permission.${item.kind}`)}</span>
            <StatusTag item={item} />
            <Button
              variant="secondary"
              disabled={state.opening}
              onClick={() => void state.open(item.kind)}
            >
              {t("computerUse.permission.open")}
            </Button>
          </div>
        ))}
      </>
    );
  }
  if (onboarding) {
    // In the welcome the rows are one soft card with status chips, not a settings section.
    return (
      <div className={styles.onboard}>
        {state.data?.unavailableReason && (
          <p className={styles.onboardNote} data-tone="warn">
            {state.data.unavailableReason === "permission_missing" && platform !== "darwin"
              ? t("computerUse.unavailable.permission_missing_desktop")
              : t(`computerUse.unavailable.${state.data.unavailableReason}`)}
          </p>
        )}
        {!!items.length && (
          <div className={styles.onboardCard}>
            {items.map((item) => (
              <div key={item.kind} className={styles.onboardRow}>
                <IconTile
                  icon={LOOK[item.kind]?.[0] ?? "shield"}
                  tone={LOOK[item.kind]?.[1] ?? "pink"}
                  size="lg"
                />
                <span className={styles.onboardText}>
                  <strong>{t(`computerUse.permission.${item.kind}`)}</strong>
                  <span className={styles.onboardSub}>
                    {t(`computerUse.permission.${item.kind}Note`)}
                  </span>
                </span>
                <Chip tone={statusTone(item) ?? "neutral"}>
                  {t(`computerUse.permissionStatus.${item.status}`)}
                </Chip>
                {missing(item) && platform === "darwin" && (
                  <Button
                    variant="pill"
                    disabled={state.opening}
                    onClick={() => void state.open(item.kind)}
                  >
                    {t("computerUse.permission.open")}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        {platform === "darwin" &&
          items.some((item) => item.kind !== "automation" && missing(item)) && (
            <p className={styles.onboardNote}>{t("computerUse.permission.staleHint")}</p>
          )}
        {state.data && !items.length && !state.data.unavailableReason && (
          <p className={styles.onboardNote}>
            {t(
              platform === "win32"
                ? "computerUse.permissions.noteWin32"
                : platform === "linux"
                  ? "computerUse.permissions.noteLinux"
                  : "computerUse.permissions.none",
            )}
          </p>
        )}
        {!state.data && !state.error && (
          <p role="status" className={styles.onboardNote}>
            {t("common.loading")}
          </p>
        )}
        {state.error && (
          <p role="alert" className={styles.onboardNote} data-tone="danger">
            <span className={styles.onboardGrow}>{t(state.error)}</span>
            <Button variant="pill" onClick={state.reload}>
              {t("common.retry")}
            </Button>
          </p>
        )}
        {state.openError && (
          <p role="alert" className={styles.onboardNote} data-tone="danger">
            {t("computerUse.permission.openError")}
          </p>
        )}
      </div>
    );
  }
  return (
    <SettingsSection title={t("computerUse.permissions.title")}>
      {state.data?.unavailableReason && (
        <SettingsLine tone="warn" dot="warn">
          {state.data.unavailableReason === "permission_missing" && platform !== "darwin"
            ? t("computerUse.unavailable.permission_missing_desktop")
            : t(`computerUse.unavailable.${state.data.unavailableReason}`)}
        </SettingsLine>
      )}
      {items.map((item) => (
        <SettingsRow
          icon={LOOK[item.kind]?.[0] ?? "shield"}
          tone={LOOK[item.kind]?.[1] ?? "pink"}
          key={item.kind}
          label={t(`computerUse.permission.${item.kind}`)}
          note={t(`computerUse.permission.${item.kind}Note`)}
        >
          {missing(item) && platform === "darwin" ? (
            <Button
              variant="secondary"
              disabled={state.opening}
              onClick={() => void state.open(item.kind)}
            >
              {t("computerUse.permission.open")}
            </Button>
          ) : (
            <StatusTag item={item} />
          )}
        </SettingsRow>
      ))}
      {/* macOS ties these grants to the app's signature, so a reinstalled build can look enabled
          in System Settings yet still be untrusted until it is removed and added again. */}
      {platform === "darwin" &&
        items.some((item) => item.kind !== "automation" && missing(item)) && (
          <SettingsLine>{t("computerUse.permission.staleHint")}</SettingsLine>
        )}
      {state.data && !items.length && !state.data.unavailableReason && (
        <SettingsLine>
          {t(
            platform === "win32"
              ? "computerUse.permissions.noteWin32"
              : platform === "linux"
                ? "computerUse.permissions.noteLinux"
                : "computerUse.permissions.none",
          )}
        </SettingsLine>
      )}
      {!state.data && !state.error && (
        <SettingsLine role="status">{t("common.loading")}</SettingsLine>
      )}
      {state.error && (
        <SettingsLine
          role="alert"
          tone="danger"
          action={
            <Button variant="ghost" onClick={state.reload}>
              {t("common.retry")}
            </Button>
          }
        >
          {t(state.error)}
        </SettingsLine>
      )}
      {state.openError && (
        <SettingsLine role="alert" tone="danger">
          {t("computerUse.permission.openError")}
        </SettingsLine>
      )}
    </SettingsSection>
  );
}
