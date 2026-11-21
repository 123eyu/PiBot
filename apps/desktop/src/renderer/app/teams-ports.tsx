import { ExternalAgentsCategory } from "@pibot/external-agents/ui";
import { useT } from "@pibot/renderer-kit";
import { type RoleCategoryExtension, TeamsUiProvider } from "@pibot/teams/ui";
import { type ReactNode, useMemo } from "react";

/** New Bot's role browser shows external agents as a category of its own. */
export function TeamsPorts({ children }: { children: ReactNode }) {
  const t = useT();
  const label = t("externalAgents.category");
  const roleCategories = useMemo<RoleCategoryExtension[]>(
    () => [{ id: "external-agents", label, render: () => <ExternalAgentsCategory /> }],
    [label],
  );
  return <TeamsUiProvider roleCategories={roleCategories}>{children}</TeamsUiProvider>;
}
