import { type ComponentType, createContext, type ReactNode, useContext } from "react";

/**
 * What the connections UI borrows from the app. Capabilities never import each other's
 * UI, so the desktop composition root supplies the work receipt view; without a provider the
 * recent-use rows simply have no receipt to open.
 */
export interface ConnectorsUiPorts {
  /** Work receipt of one run (the same view chat replies and routine runs show). */
  RunReceipt?: ComponentType<{ runId: string }>;
}

const Context = createContext<ConnectorsUiPorts>({});

export function ConnectorsUiProvider({
  ports,
  children,
}: {
  ports: ConnectorsUiPorts;
  children: ReactNode;
}) {
  return <Context.Provider value={ports}>{children}</Context.Provider>;
}

export function useConnectorsPorts(): ConnectorsUiPorts {
  return useContext(Context);
}
