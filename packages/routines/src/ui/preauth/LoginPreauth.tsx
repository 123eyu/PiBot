import {
  credentialSiteLabel,
  type Permissions,
  type RoutinePreauthInput,
  RoutinePreauthInputSchema,
} from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { useRoutinesPorts } from "../shell/ports.tsx";
import routineStyles from "../shell/routines.module.css";
import { PreauthRow } from "./PreauthRow.tsx";

const loginOp = (site: string): RoutinePreauthInput | undefined => {
  const parsed = RoutinePreauthInputSchema.safeParse({
    category: "web",
    scope: { kind: "login", site },
  });
  return parsed.success ? parsed.data : undefined;
};
const siteOf = (op: RoutinePreauthInput) =>
  op.category === "web" && op.scope.kind === "login" ? op.scope.site : undefined;

/**
 * A routine can allow automatic login ahead of time, per saved site of its Bot. Only
 * sites with an account this Bot may use are offered; brain re-checks on save and at run time.
 */
export function LoginPreauth({
  selected,
  change,
  permissions,
}: {
  selected: RoutinePreauthInput[];
  change(ops: RoutinePreauthInput[]): void;
  permissions?: Permissions;
}) {
  const t = useT();
  const botId = permissions?.botId;
  const saved = useRoutinesPorts().useSavedLoginSites(botId);
  if (!botId) return null;
  const chosen = new Set(selected.map(siteOf).filter(Boolean));
  const sites = [...new Set([...saved, ...chosen])] as string[];
  const never = permissions?.effective?.levels.web === "never";
  return (
    <fieldset className={routineStyles.stack}>
      <legend>{t("credentials.preauth.title")}</legend>
      <p className={routineStyles.note}>
        {sites.length ? t("credentials.preauth.note") : t("credentials.preauth.none")}
      </p>
      {sites.length > 0 && (
        <div className={routineStyles.optRows}>
          {sites.map((site) => {
            const op = loginOp(site);
            if (!op) return null;
            const checked = chosen.has(site);
            return (
              <PreauthRow
                key={site}
                kind="login"
                label={t("credentials.grantLabel", { site: credentialSiteLabel(site) })}
                checked={checked}
                disabled={!checked && (never || selected.length >= 200)}
                change={(on) =>
                  change(on ? [...selected, op] : selected.filter((item) => siteOf(item) !== site))
                }
              />
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
