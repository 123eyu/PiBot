import type { DeviceView } from "@pibot/remote-contract";
import {
  SettingsLine,
  SettingsRow,
  SettingsSection,
  useRpc,
  useSettings,
  useT,
} from "@pibot/renderer-kit";
import { Button, Chip, Switch } from "@pibot/ui";
import { useEffect, useState } from "react";
import styles from "../settings/remote.module.css";
import { EndpointScope } from "./EndpointScope.tsx";
import {
  type EndpointChange,
  type EndpointRow,
  useEndpointCapabilities,
} from "./use-endpoint-capabilities.ts";

type Scope = EndpointRow["scope"];

function useMissingComputerPermission(enabled: boolean) {
  const { peer } = useRpc();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    setMissing(false);
    if (!peer || !enabled) return;
    const lifetime = new AbortController();
    let read: AbortController | undefined;
    const refresh = () => {
      read?.abort();
      const controller = new AbortController();
      read = controller;
      void peer
        .call("computer.permissions", undefined, {
          signal: AbortSignal.any([controller.signal, lifetime.signal]),
          timeoutMs: 5_000,
        })
        .then(
          (permissions) => {
            if (!controller.signal.aborted && !lifetime.signal.aborted)
              setMissing(
                permissions.unavailableReason === "permission_missing" ||
                  permissions.items.some(
                    ({ kind, status }) =>
                      kind !== "automation" && (status === "denied" || status === "not_determined"),
                  ),
              );
          },
          () => {
            if (!controller.signal.aborted && !lifetime.signal.aborted) setMissing(false);
          },
        );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      lifetime.abort();
      window.removeEventListener("focus", refresh);
    };
  }, [enabled, peer]);
  return enabled && missing;
}

/**
 * Maintainers 2026-11-13: a capability's Bot / group scope applies as it is changed, with no Save; the
 * row's 范围 button closes the editor. A failed save puts the saved scope back.
 */
function ScopeEditor({
  row,
  disabled,
  save,
}: {
  row: EndpointRow;
  disabled: boolean;
  save(scope: Scope): Promise<boolean>;
}) {
  const t = useT();
  const [scope, setScope] = useState(row.scope);
  const [saved, setSaved] = useState(false);
  useEffect(() => setScope(row.scope), [row.scope]);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);
  const apply = (next: Scope) => {
    setScope(next);
    setSaved(false);
    void save(next).then((ok) => {
      if (ok) setSaved(true);
      else setScope(row.scope);
    });
  };
  return (
    <div className={styles.scopeEditor}>
      <p>
        {t("remote.cap.scope.note")}
        {saved && (
          <>
            {" "}
            <Chip tone="ok">{t("remote.saved")}</Chip>
          </>
        )}
      </p>
      <EndpointScope
        kind="bots"
        value={scope.botIds}
        disabled={disabled}
        change={(botIds) => apply({ ...scope, botIds })}
      />
      <EndpointScope
        kind="groups"
        value={scope.groupIds}
        disabled={disabled}
        change={(groupIds) => apply({ ...scope, groupIds })}
      />
    </div>
  );
}

function CapabilityRow({
  row,
  disabled,
  missing,
  editing,
  edit,
  save,
}: {
  row: EndpointRow;
  disabled: boolean;
  missing: boolean;
  editing: boolean;
  edit(open: boolean): void;
  save(input: EndpointChange): Promise<boolean>;
}) {
  const { t, language } = useSettings();
  const name = row.name[language];
  const enabled = row.state !== "off";
  const available = row.online && row.availability === "available" && !missing;
  const saveChange = (nextEnabled: boolean, scope: Scope) =>
    save({
      endpointId: row.endpointId,
      capabilityId: row.capabilityId,
      enabled: nextEnabled,
      scope,
    });
  const range = (ids: string[] | null) =>
    ids === null
      ? t("remote.cap.scope.all")
      : ids.length
        ? t("remote.cap.scope.count", { count: ids.length })
        : t("remote.cap.scope.none");
  return (
    <>
      <SettingsRow
        label={name}
        dot={available && enabled ? "ok" : "warn"}
        note={
          <>
            {t(`remote.cap.availability.${row.availability}`)}
            {!row.online && <> · {t("remote.offline")}</>}
            {missing && <> · {t("remote.cap.permissionMissing")}</>}
            {" · "}
            {t(`remote.cap.state.${row.state}`)}
            <br />
            {t("remote.cap.scope.summary", {
              bots: range(row.scope.botIds),
              groups: range(row.scope.groupIds),
            })}
            <br />
            {row.lastCalledAt
              ? t("remote.cap.lastCalled", {
                  time: new Date(row.lastCalledAt).toLocaleString(
                    language === "zh" ? "zh-CN" : "en",
                  ),
                })
              : t("remote.cap.neverCalled")}
          </>
        }
      >
        <div className={styles.actions}>
          <Button
            variant="secondary"
            disabled={disabled}
            aria-expanded={editing}
            onClick={() => edit(!editing)}
          >
            {t("remote.cap.scope.edit")}
          </Button>
          <Switch
            label={t("remote.cap.toggle", { name })}
            checked={enabled}
            disabled={disabled || editing}
            onCheckedChange={(checked) => {
              void saveChange(checked, row.scope);
            }}
          />
        </div>
      </SettingsRow>
      {editing && (
        <ScopeEditor row={row} disabled={disabled} save={(scope) => saveChange(enabled, scope)} />
      )}
    </>
  );
}

const rowKey = (row: EndpointRow) => `${row.endpointId}:${row.capabilityId}`;
const scopeVersion = (row: EndpointRow) => JSON.stringify([row.version, row.state, row.scope]);

export function EndpointCapabilities({
  paired,
  endpointId,
}: {
  paired: readonly DeviceView[];
  endpointId?: string;
}) {
  const { t, language } = useSettings();
  const data = useEndpointCapabilities();
  const [editor, setEditor] = useState<{ key: string; version: string }>();
  const missing = useMissingComputerPermission(
    data.rows.some((row) => row.endpointId === "local" && row.capabilityId === "desktop.computer"),
  );
  const devices = new Map<string, EndpointRow[]>();
  for (const row of data.rows) {
    if (endpointId && row.endpointId !== endpointId) continue;
    const group = devices.get(row.endpointId);
    if (group) group.push(row);
    else devices.set(row.endpointId, [row]);
  }
  const pairedById = new Map(paired.map((device) => [device.id, device]));
  if (data.connected && !data.loading && !data.failed && !data.hasMore) {
    for (const device of paired) {
      if (endpointId && device.id !== endpointId) continue;
      if (!device.revokedAt && !devices.has(device.id)) devices.set(device.id, []);
    }
  }
  const selected = editor && data.rows.find((row) => rowKey(row) === editor.key);
  const stale = editor && (!selected || scopeVersion(selected) !== editor.version);
  const disabled = data.loading || data.failed || data.saving || !data.connected;
  return (
    <SettingsSection
      title={t("remote.cap.title")}
      bare
      action={
        <Button
          variant="secondary"
          disabled={data.loading || data.saving || !data.connected}
          onClick={() => {
            void data.reload();
          }}
        >
          {t("remote.cap.refresh")}
        </Button>
      }
    >
      <div className={styles.endpointList}>
        {data.loading && <SettingsLine role="status">{t("remote.loading")}</SettingsLine>}
        {!data.connected && !data.loading && (
          <SettingsLine role="status">{t("remote.cap.disconnected")}</SettingsLine>
        )}
        {data.failed && (
          <SettingsLine role="alert" tone="danger">
            {t("remote.cap.loadFailed")}
          </SettingsLine>
        )}
        {data.saveFailed && (
          <SettingsLine role="alert" tone="danger">
            {t("remote.cap.saveFailed")}
          </SettingsLine>
        )}
        {stale && (
          <SettingsLine
            role="status"
            action={
              <Button variant="secondary" onClick={() => setEditor(undefined)}>
                {t("remote.cap.dismiss")}
              </Button>
            }
          >
            {t("remote.cap.scope.stale")}
          </SettingsLine>
        )}
        {data.connected && !devices.size && !data.loading && !data.failed && (
          <SettingsLine>{t("remote.cap.empty")}</SettingsLine>
        )}
        {[...devices]
          .sort(([left], [right]) => Number(right === "local") - Number(left === "local"))
          .map(([id, rows]) => {
            const first = rows[0];
            const device = pairedById.get(id);
            return (
              <div className={styles.endpointCard} key={id}>
                <h3>
                  {device?.name ??
                    (first && first.endpointName[language] !== id
                      ? first.endpointName[language]
                      : t(`remote.cap.device.${first?.endpointKind ?? device?.kind ?? "runner"}`))}
                </h3>
                {!first && (
                  <SettingsLine>
                    {t(device?.online ? "remote.online" : "remote.offline")} ·{" "}
                    {t("remote.cap.unregistered")}
                  </SettingsLine>
                )}
                {rows.map((row) => {
                  const key = rowKey(row);
                  return (
                    <CapabilityRow
                      key={key}
                      row={row}
                      disabled={disabled || !!device?.revokedAt}
                      missing={missing && id === "local" && row.capabilityId === "desktop.computer"}
                      editing={!stale && editor?.key === key}
                      edit={(open) =>
                        setEditor(open ? { key, version: scopeVersion(row) } : undefined)
                      }
                      save={data.save}
                    />
                  );
                })}
              </div>
            );
          })}
        {data.hasMore && (
          <div className={styles.actions}>
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => {
                void data.more();
              }}
            >
              {t("remote.more")}
            </Button>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
