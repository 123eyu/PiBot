import { BrowserPane } from "@pibot/browser/ui";
import { useConnectionChoices } from "@pibot/plugins/ui";
import { useRoutineNavigation } from "@pibot/routines/ui";
import { type SkillsUiPorts, SkillsUiProvider } from "@pibot/skills/ui";
import type { ReactNode } from "react";
import { PanelMenu } from "../features/workspace/profile/PanelMenu.tsx";

const ports: SkillsUiPorts = { BrowserPane, PanelMenu, useRoutineNavigation, useConnectionChoices };
export function SkillsPorts({ children }: { children: ReactNode }) {
  return <SkillsUiProvider ports={ports}>{children}</SkillsUiProvider>;
}
