import type { ExecutionTopic } from "@pibot/client-core";
import type { IconName } from "@pibot/ui";
import { type ComponentType, createContext, type ReactNode, useContext } from "react";
/** Borrowed execution widgets are supplied by the desktop shell, not imported across capabilities. */
export interface WorkspacesUiPorts {
  useExecution(): { conversationId?: string; topics: ExecutionTopic[] } | null;
  ReviewEvidencePanel: ComponentType<{
    botId: string;
    conversationId: string;
    rootId?: string;
    expanded?: boolean;
    hideTitle?: boolean;
  }>;
  PopupMenu: ComponentType<{
    label: string;
    children: ReactNode;
    icon?: IconName;
    placement?: "above" | "below";
    onOpenChange?(open: boolean): void;
    disabled?: boolean;
    showLabel?: boolean;
  }>;
}
const Context = createContext<WorkspacesUiPorts | undefined>(undefined);
export function WorkspacesUiProvider({
  ports,
  children,
}: {
  ports: WorkspacesUiPorts;
  children: ReactNode;
}) {
  return <Context.Provider value={ports}>{children}</Context.Provider>;
}
export function useWorkspacesPorts() {
  const ports = useContext(Context);
  if (!ports) throw new Error("WorkspacesUiProvider is required");
  return ports;
}
export function useWorkspaceExecution() {
  return useWorkspacesPorts().useExecution();
}
export function WorkspaceEvidencePanel(
  props: React.ComponentProps<WorkspacesUiPorts["ReviewEvidencePanel"]>,
) {
  const Panel = useWorkspacesPorts().ReviewEvidencePanel;
  return <Panel {...props} />;
}
export function WorkspacePopupMenu(props: React.ComponentProps<WorkspacesUiPorts["PopupMenu"]>) {
  const Menu = useWorkspacesPorts().PopupMenu;
  return <Menu {...props} />;
}
