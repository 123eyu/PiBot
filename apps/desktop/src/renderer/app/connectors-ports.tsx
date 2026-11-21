import { type ConnectorsUiPorts, ConnectorsUiProvider } from "@pibot/plugins/ui";
import type { ReactNode } from "react";
import { RunReceipt } from "../features/receipt/RunReceipt.tsx";

// Built once: the component is module-level, so the context value never changes.
const ports: ConnectorsUiPorts = { RunReceipt };

/** Composition root for the connections UI: the receipt view a recent call opens. */
export function ConnectorsPorts({ children }: { children: ReactNode }) {
  return <ConnectorsUiProvider ports={ports}>{children}</ConnectorsUiProvider>;
}
