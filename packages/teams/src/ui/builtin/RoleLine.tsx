import type { Bot } from "@pibot/protocol";
import { botPanelStyles as panelStyles, useT } from "@pibot/renderer-kit";
import { IconTile } from "@pibot/ui";
import { useBuiltinCatalog } from "./shared.tsx";

/** Which built-in role (and version) a Bot was made from; a mark only, never synced. */
export function RoleLine({ role }: { role: NonNullable<Bot["role"]> }) {
  const t = useT();
  const { catalog } = useBuiltinCatalog();
  const name = catalog?.roles.find((item) => item.id === role.id)?.name ?? role.id;
  // An IconTile row in a soft card, like the panel's other facts.
  return (
    <div className={panelStyles.card}>
      <div className={panelStyles.cardRow}>
        <IconTile icon="briefcase" tone="violet" size="lg" />
        <span className={panelStyles.rowText}>
          <strong>{t("builtin.profile.role", { name, version: role.version })}</strong>
        </span>
      </div>
    </div>
  );
}
