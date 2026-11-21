import type { Peer } from "@pibot/renderer-kit";
import type { IconName } from "@pibot/ui";
import { type ComponentType, createContext, type ReactNode, useContext } from "react";
/** App-shell features are injected; browser UI does not load another capability's UI. */
export interface BrowserUiPorts {
  SaveLoginPrompt: ComponentType<{ botId: string }>;
  TakeoverAccounts: ComponentType<{ botId: string; groupId?: string; peer: Peer; pageKey: string }>;
  PopupMenu: ComponentType<{
    label: string;
    children: ReactNode;
    icon?: IconName;
    placement?: "above" | "below";
    onOpenChange?(open: boolean): void;
    disabled?: boolean;
    showLabel?: boolean;
  }>;
  onBrowserFrames(
    callback: (botId: string, port: MessagePort, groupId?: string) => void,
  ): () => void;
}
const Context = createContext<BrowserUiPorts | undefined>(undefined);
export function BrowserUiProvider({
  ports,
  children,
}: {
  ports: BrowserUiPorts;
  children: ReactNode;
}) {
  return <Context.Provider value={ports}>{children}</Context.Provider>;
}
export function useBrowserUiPorts() {
  const ports = useContext(Context);
  if (!ports) throw new Error("BrowserUiProvider is required");
  return ports;
}
