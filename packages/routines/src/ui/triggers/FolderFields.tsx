import type { RoutineDraft } from "@pibot/protocol";
import { useRpc, useSettings } from "@pibot/renderer-kit";
import styles from "../shell/routines.module.css";

type Trigger = RoutineDraft["triggers"][number];

import { Button, IconTile, SegmentedControl, Switch } from "@pibot/ui";
import { useRef } from "react";
import { useRoutineAction } from "../shell/remote.ts";
export function FolderFields({
  value,
  change,
}: {
  value: Extract<Trigger, { kind: "folder" }>;
  change(value: Trigger): void;
}) {
  const { t } = useSettings();
  const { peer } = useRpc();
  const action = useRoutineAction();
  const latest = useRef({ value, change });
  latest.current = { value, change };
  return (
    <>
      <div className={styles.pathField}>
        <IconTile icon="folder" tone="amber" size="sm" />
        <span className={styles.grow}>{value.path || t("routines.pickFolder")}</span>
        <Button
          variant="secondary"
          disabled={action.disabled}
          onClick={() => {
            if (peer)
              void action
                .run(() => peer.call("routines.pickFolder", undefined))
                .then((path) => {
                  if (path) latest.current.change({ ...latest.current.value, path });
                });
          }}
        >
          {t("routines.pickFolder")}
        </Button>
      </div>
      {action.error && (
        <p role="alert" className={styles.error}>
          {t(action.error)}
        </p>
      )}
      <div className={styles.grid}>
        <div className={styles.field}>
          <span className={styles.label}>{t("routines.events")}</span>
          <SegmentedControl
            className={styles.seg}
            label={t("routines.events")}
            value={value.events}
            options={[
              { value: "new", label: t("routines.events.new") },
              { value: "new_and_changed", label: t("routines.events.changed") },
            ]}
            onValueChange={(events) => change({ ...value, events })}
          />
        </div>
        <label className={styles.field}>
          {t("routines.pattern")}
          <input
            required
            maxLength={500}
            value={value.pattern}
            onChange={(e) => change({ ...value, pattern: e.currentTarget.value })}
          />
        </label>
      </div>
      <div className={styles.switchRow}>
        <span>{t("routines.recursive")}</span>
        <Switch
          label={t("routines.recursive")}
          checked={value.recursive}
          onCheckedChange={(recursive) => change({ ...value, recursive })}
        />
      </div>
      <label className={styles.switchRow}>
        <span>{t("routines.cooldown")}</span>
        <input
          required
          type="number"
          className={styles.small}
          min={1}
          max={60}
          value={value.cooldownMin}
          onChange={(e) => change({ ...value, cooldownMin: e.currentTarget.valueAsNumber })}
        />
      </label>
      <p className={styles.note}>{t("routines.monitorNote")}</p>
    </>
  );
}
