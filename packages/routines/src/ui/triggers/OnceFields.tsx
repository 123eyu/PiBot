import type { RoutineDraft } from "@pibot/protocol";
import { AppSelect, DateField, type Peer, useSettings } from "@pibot/renderer-kit";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRemote } from "../shell/remote.ts";
import styles from "../shell/routines.module.css";
import { systemTimezone } from "./cron.ts";
import { offsetText, onceLocalTime, onceText } from "./once.ts";
import { timezoneOptions } from "./timezones.ts";

type Once = Extract<RoutineDraft["triggers"][number], { kind: "once" }>;
export function OnceFields({
  value,
  change,
  disabled,
  initialLocalTime,
}: {
  value: Once;
  change(value: Once): void;
  disabled: boolean;
  initialLocalTime?: string;
}) {
  const { t, language } = useSettings();
  const [localTime, setLocalTime] = useState(() =>
    (initialLocalTime ?? onceLocalTime(value.at, value.timezone)).slice(0, 16),
  );
  const [choice, setChoice] = useState<"earlier" | "later">();
  const savedAt = useRef(value.at);
  const options = useMemo(
    () => timezoneOptions(systemTimezone(), value.timezone),
    [value.timezone],
  );
  const load = useCallback(
    (peer: Peer) => {
      if (!localTime) return Promise.resolve(undefined);
      return peer.call("routines.resolveOnceTime", {
        localTime,
        timezone: value.timezone,
        ...(choice ? { disambiguation: choice } : {}),
      });
    },
    [localTime, value.timezone, choice],
  );
  const remote = useRemote(load);
  useEffect(() => {
    if (disabled || remote.loading) return;
    // Showing minute precision must not reschedule an existing task merely by opening its editor.
    if (
      savedAt.current &&
      localTime === onceLocalTime(savedAt.current, value.timezone).slice(0, 16)
    )
      return;
    const result = remote.value;
    if (result?.status === "ambiguous" && savedAt.current) {
      const index = result.candidates.findIndex((c) => c.at === savedAt.current);
      if (index >= 0) {
        setChoice(index === 0 ? "earlier" : "later");
        return;
      }
    }
    const at = result?.at ?? "";
    if (value.at !== at) change({ ...value, at });
  }, [remote.value, remote.loading, value, change, disabled, localTime]);
  const reset = () => {
    savedAt.current = "";
    setChoice(undefined);
    change({ ...value, at: "" });
  };
  return (
    <>
      <label className={styles.field}>
        {t("routines.once.time")}
        <DateField
          mode="datetime"
          label={t("routines.once.time")}
          tone="orange"
          appearance="tinted"
          required
          value={localTime}
          disabled={disabled}
          onValueChange={(next) => {
            reset();
            setLocalTime(next);
          }}
        />
      </label>
      <AppSelect
        label={t("routines.timezone")}
        value={value.timezone}
        options={options}
        disabled={disabled}
        change={(timezone) => {
          if (!disabled) {
            reset();
            change({ ...value, at: "", timezone });
          }
        }}
      />
      <p className={styles.note}>{t("routines.timezoneNote")}</p>
      {remote.loading && <p role="status">{t("routines.once.resolving")}</p>}
      {remote.error && (
        <p role="alert" className={styles.error}>
          {t(remote.error)}
        </p>
      )}
      {remote.value?.candidates.length === 2 && (
        <div className={styles.field}>
          <span className={styles.label}>{t("routines.once.ambiguous")}</span>
          <div className={styles.chips}>
            {remote.value.candidates.map((c, index) => {
              const which = index === 0 ? "earlier" : "later";
              return (
                <button
                  key={c.at}
                  type="button"
                  className={styles.chip}
                  disabled={disabled}
                  aria-pressed={choice === which}
                  onClick={() => {
                    savedAt.current = "";
                    change({ ...value, at: "" });
                    setChoice(which);
                  }}
                >
                  {t(index === 0 ? "routines.once.earlier" : "routines.once.later")} ·{" "}
                  {offsetText(c.offsetMinutes)} · {c.at}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {(remote.value?.status === "nonexistent" || remote.value?.status === "invalid") && (
        <p role="alert" className={styles.error}>
          {t("routines.once.nonexistent")}
        </p>
      )}
      {value.at && (
        <p className={styles.note}>
          {t("routines.once")} · {onceText(value.at, value.timezone, language)} · {value.at}
        </p>
      )}
      <p className={styles.note}>{t("routines.once.note")}</p>
    </>
  );
}
