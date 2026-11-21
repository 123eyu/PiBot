import type {
  ComputerApp,
  Level,
  MethodParams,
  Permissions,
  ScopedComputerAlways,
} from "@pibot/computer-use-contract/full";
import {
  PermissionRow,
  botPanelStyles as panelStyles,
  useRpc,
  useRpcEvent,
  useT,
} from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useEffect, useRef, useState } from "react";
import styles from "../computer.module.css";
import { computerErrorKey } from "../presentation.ts";
import { AppListEditor } from "./AppListEditor.tsx";

interface ComputerPermissionsEditor {
  data?: Permissions;
  global?: Permissions;
  busy: boolean;
  refreshing: boolean;
  connected: boolean;
  error: boolean;
  save(patch: Omit<MethodParams["permissions.set"], "botId" | "groupId">): Promise<boolean>;
}

type Mode = "inherit" | Level;

/**
 * Profile panel · Permissions & connections: the Bot's
 * computer level and, for "always", the app list. Screenshot clicks can never be made "always".
 */
export function ProfileComputer({
  botId,
  groupId,
  permissions,
}: {
  permissions: ComputerPermissionsEditor;
} & ({ botId: string; groupId?: never } | { groupId: string; botId?: never })) {
  const t = useT();
  const { peer } = useRpc();
  const [always, setAlways] = useState<ScopedComputerAlways | null>();
  const [listError, setListError] = useState<ReturnType<typeof computerErrorKey>>();
  const [saveError, setSaveError] = useState<ReturnType<typeof computerErrorKey>>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const locked = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the explicit reread trigger
  useEffect(() => {
    if (!peer) return;
    let active = true;
    setListError(undefined);
    setAlways(undefined);
    peer
      .call("computer.always.get", groupId ? { groupId } : { botId: botId as string })
      .then((result) => {
        if (active) setAlways(result);
      })
      .catch((e: unknown) => {
        if (active) setListError(computerErrorKey(e));
      });
    return () => {
      active = false;
    };
  }, [peer, botId, groupId, revision]);
  // The grant card's "don't ask again" changes the list in brain and emits permissions.changed.
  useRpcEvent("permissions.changed", (event) => {
    if (
      (!event.botId && !event.groupId) ||
      (groupId ? event.groupId === groupId : !event.groupId && event.botId === botId)
    )
      setRevision((n) => n + 1);
  });
  const override = permissions.data?.overrides?.computer;
  const globalLevel = permissions.global?.levels.computer ?? "ask";
  // The row shows the level in effect, with the same choices as the global setting.
  const mode: Level = permissions.data?.effective?.levels.computer ?? override ?? globalLevel;
  const apps = always?.apps ?? [];
  const run = async (task: () => Promise<void>) => {
    if (!peer || locked.current) return;
    locked.current = true;
    setBusy(true);
    setSaveError(undefined);
    try {
      await task();
    } catch (e) {
      setSaveError(computerErrorKey(e));
      setRevision((n) => n + 1);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const setMode = (next: Mode) =>
    // Leaving "always" keeps the list; policy reads it only while the level is "always",
    // so it stays inert until the user switches back.
    void run(async () => {
      await permissions.save({ levels: { computer: next === "inherit" ? null : next } });
    });
  const setApps = (next: ComputerApp[]) =>
    void run(async () => {
      if (!peer) return;
      if (next.length)
        setAlways(
          await peer.call(
            "computer.always.set",
            groupId ? { groupId, apps: next } : { botId: botId as string, apps: next },
          ),
        );
      else {
        await peer.call(
          "computer.always.clear",
          groupId ? { groupId } : { botId: botId as string },
        );
        setAlways(null);
      }
    });
  const disabled =
    busy ||
    permissions.busy ||
    permissions.refreshing ||
    !permissions.connected ||
    permissions.error ||
    !permissions.data;
  // Requires a chosen app list. Keep the route back to "always" after switching to ask.
  const options = [
    { value: "never" as const, label: t("permissions.level.never") },
    { value: "ask" as const, label: t("permissions.level.ask") },
    ...(mode === "always" || apps.length > 0
      ? [{ value: "always" as const, label: t("permissions.level.always") }]
      : []),
  ];
  return (
    <section className={panelStyles.section}>
      <h2>{t("permissions.category.computer")}</h2>
      <div className={panelStyles.card}>
        <PermissionRow<Level>
          icon={{ name: "hand", tone: "pink" }}
          label={t("permissions.category.computer")}
          value={mode}
          overridden={override !== undefined}
          disabled={disabled}
          options={options}
          change={setMode}
          restore={() => setMode("inherit")}
        />
      </div>
      {/* Hidden until the list is read, so a failed read cannot be overwritten by an edit. */}
      {mode === "always" && always !== undefined && (
        <>
          <p className={panelStyles.note}>{t("computerUse.profile.listLabel")}</p>
          <AppListEditor apps={apps} onChange={setApps} disabled={disabled} />
          <p className={styles.banner}>
            {t("computerUse.profile.info")}
            {!apps.length && <strong>{t("computerUse.profile.empty")}</strong>}
          </p>
        </>
      )}
      {mode !== "always" && always !== undefined && (
        <>
          <p className={panelStyles.note}>{t("computerUse.profile.inactive")}</p>
          <AppListEditor apps={apps} onChange={setApps} disabled={disabled} />
        </>
      )}
      {listError && (
        <p role="alert" className={panelStyles.error}>
          {t(listError)}{" "}
          <Button variant="pill" onClick={() => setRevision((n) => n + 1)}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {saveError && (
        <p role="alert" className={panelStyles.error}>
          {t(saveError)}
        </p>
      )}
    </section>
  );
}
