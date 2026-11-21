import { type WorkspacesUiPorts, WorkspacesUiProvider } from "@pibot/workspaces/ui";
import type { ReactNode } from "react";
import { PopupMenu } from "../features/execution/PopupMenu.tsx";
import { ReviewEvidencePanel } from "../features/execution/ReviewEvidencePanel.tsx";
import { useExecution } from "../features/execution/workspace.tsx";

const ports: WorkspacesUiPorts = { PopupMenu, ReviewEvidencePanel, useExecution };
export function WorkspacesPorts({ children }: { children: ReactNode }) {
  return <WorkspacesUiProvider ports={ports}>{children}</WorkspacesUiProvider>;
}
