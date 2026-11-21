import type { MethodResults } from "@pibot/protocol";
import { SettingsLine, SettingsRow, useRpc, useRpcEvent, useT } from "@pibot/renderer-kit";
import { Button, Switch } from "@pibot/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import styles from "../settings/remote.module.css";

export function RunnerControl({
  phoneId,
  runnerDeviceId,
  disabled,
}: {
  phoneId?: string;
  runnerDeviceId?: string;
  disabled: boolean;
}) {
  const t = useT();
  const { peer } = useRpc();
  const owner = useRef<AbortController>(undefined);
  const read = useRef<AbortController>(undefined);
  const write = useRef(false);
  const [view, setView] = useState<MethodResults["remote.runnerControl.get"]>();
  const [after, setAfter] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    if (!peer || !owner.current || owner.current.signal.aborted) return;
    read.current?.abort();
    const pending = new AbortController();
    read.current = pending;
    try {
      const result = await peer.call(
        "remote.runnerControl.get",
        { phoneId, runnerDeviceId, after },
        {
          signal: AbortSignal.any([owner.current.signal, pending.signal]),
          timeoutMs: 15_000,
        },
      );
      if (read.current === pending && !pending.signal.aborted && !owner.current.signal.aborted) {
        setView(result);
        setFailed(false);
      }
    } catch {
      if (!pending.signal.aborted && !owner.current?.signal.aborted) setFailed(true);
    }
  }, [peer, phoneId, runnerDeviceId, after]);
  useEffect(() => {
    const active = new AbortController();
    owner.current = active;
    setView(undefined);
    setBusy(false);
    setFailed(false);
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => {
      active.abort();
      read.current?.abort();
      clearInterval(timer);
    };
  }, [load]);
  useRpcEvent("devices.changed", () => void load());
  const change = async (
    phoneId: string,
    runnerDeviceId: string,
    enabled: boolean,
    expectedRevision: number,
  ) => {
    if (!peer || !owner.current || write.current) return;
    const active = owner.current;
    write.current = true;
    setBusy(true);
    try {
      await peer.call(
        "remote.runnerControl.set",
        { phoneId, runnerDeviceId, enabled, expectedRevision },
        { signal: active.signal, timeoutMs: 20_000 },
      );
    } catch {
      if (!active.signal.aborted) setFailed(true);
    } finally {
      write.current = false;
      if (!active.signal.aborted) {
        setBusy(false);
        void load();
      }
    }
  };
  return (
    <div className={styles.endpointCard}>
      <h3>{t("remote.runnerControl.title")}</h3>
      <SettingsLine>{t("remote.runnerControl.note")}</SettingsLine>
      {failed && (
        <SettingsLine
          tone="warn"
          action={<Button onClick={() => void load()}>{t("remote.retry")}</Button>}
        >
          {t("remote.cap.saveFailed")}
        </SettingsLine>
      )}
      {!view && !failed && <SettingsLine>{t("remote.runnerControl.loading")}</SettingsLine>}
      {view?.items.map((item) => (
        <SettingsRow
          key={`${item.phoneId}:${item.runnerDeviceId}`}
          label={item.name}
          note={
            <>
              {t(`remote.runnerControl.${item.state}`)}
              {item.expiresAt !== null && (
                <>
                  {" "}
                  ·{" "}
                  {t("remote.runnerControl.expires", {
                    time: new Date(item.expiresAt).toLocaleString(),
                  })}
                </>
              )}
            </>
          }
        >
          <Switch
            label={t("remote.runnerControl.title")}
            checked={item.enabled}
            disabled={disabled || busy || !item.editable}
            onCheckedChange={(enabled) =>
              void change(item.phoneId, item.runnerDeviceId, enabled, item.revision)
            }
          />
        </SettingsRow>
      ))}
      {view?.items.length === 0 && <SettingsLine>{t("remote.runnerControl.empty")}</SettingsLine>}
      {after && (
        <Button onClick={() => setAfter(undefined)}>{t("remote.runnerControl.first")}</Button>
      )}
      {view?.nextAfter && (
        <Button onClick={() => setAfter(view.nextAfter ?? undefined)}>
          {t("remote.runnerControl.next")}
        </Button>
      )}
    </div>
  );
}
