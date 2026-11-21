import {
  type ComputerApp,
  type Permissions,
  type RoutinePreauthInput,
  RoutinePreauthInputSchema,
  sameAppId,
} from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { useRoutinesPorts } from "../shell/ports.tsx";
import styles from "../shell/routines.module.css";

/*
 * Routines may preauthorize "operate the computer: app list", never screenshot clicks.
 * The scope stores app IDs only (grants match by ID), so names are looked up for display.
 */
function computerScope(apps: ComputerApp[]) {
  return { kind: "apps", apps: apps.map((app) => app.id) };
}
export function computerPreauthOp(apps: ComputerApp[]): RoutinePreauthInput | undefined {
  const parsed = RoutinePreauthInputSchema.safeParse({
    category: "computer",
    scope: computerScope(apps),
  });
  return parsed.success ? parsed.data : undefined;
}
const probe = [{ id: "com.example.app", name: "Example" }];
export const computerPreauthSupported = () => computerPreauthOp(probe) !== undefined;

function opAppIds(op: RoutinePreauthInput): string[] {
  return op.category === "computer" && op.scope.kind === "apps" ? op.scope.apps : [];
}

export function ComputerPreauth({
  selected,
  change,
  permissions,
}: {
  selected: RoutinePreauthInput[];
  change(ops: RoutinePreauthInput[]): void;
  permissions?: Permissions;
}) {
  const t = useT();
  const supported = computerPreauthSupported();
  const level = permissions?.effective?.levels.computer;
  const current = selected.find((op) => op.category === "computer");
  const ids = current ? opAppIds(current) : [];
  // The scan takes seconds on macOS; only run it when there are saved IDs to name.
  const { useInstalledApps, AppListEditor } = useRoutinesPorts();
  const installed = useInstalledApps(ids.length > 0);
  const known = installed.data?.supported === true ? installed.data.apps : [];
  const apps: ComputerApp[] = ids.map((id) => ({
    id,
    name: known.find((app) => sameAppId(app.id, id))?.name ?? id,
  }));
  const others = selected.filter((op) => op.category !== "computer");
  const setApps = (next: ComputerApp[]) => {
    const op = next.length ? computerPreauthOp(next) : undefined;
    change(op ? [...others, op] : others);
  };
  return (
    <fieldset className={styles.stack}>
      <legend>{t("permissions.category.computer")}</legend>
      {level === "never" ? (
        <p className={styles.note}>{t("computerUse.preauth.never")}</p>
      ) : !supported ? (
        <p className={styles.note}>{t("computerUse.preauth.pending")}</p>
      ) : (
        <>
          <p className={styles.note}>
            {apps.length
              ? t("computerUse.preauth.apps", {
                  apps: apps.map((app) => app.name).join(t("computerUse.listSeparator")),
                })
              : t("computerUse.preauth.none")}
          </p>
          <AppListEditor apps={apps} onChange={setApps} />
        </>
      )}
      <p className={styles.note}>
        <span className={styles.appTag}>{t("computerUse.preauth.coordinatesTag")}</span>{" "}
        {t("computerUse.preauth.coordinates")}
      </p>
    </fieldset>
  );
}
