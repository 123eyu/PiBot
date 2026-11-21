import { AppListEditor, useInstalledApps } from "@pibot/computer-use/ui";
import { useCredentialList } from "@pibot/credentials/ui";
import { ConnectorFeedback, ConnectorPagination, useConnectorPage } from "@pibot/plugins/ui";
import { type RoutinesUiPorts, RoutinesUiProvider } from "@pibot/routines/ui";
import type { ReactNode } from "react";
import { useBackgroundExitBehavior } from "../features/background/use-background-exit-behavior.ts";
import { RunReceipt } from "../features/receipt/RunReceipt.tsx";

function useSavedLoginSites(botId: string | undefined) {
  return useCredentialList(botId).items.map((item) => item.site);
}

// Built once: the hooks and components are module-level, so the context value never changes.
const ports: RoutinesUiPorts = {
  platform: window.pibot.platform,
  useExitBehavior: useBackgroundExitBehavior,
  useSavedLoginSites,
  useInstalledApps,
  AppListEditor,
  useConnectorPage,
  ConnectorFeedback,
  ConnectorPagination,
  RunReceipt,
};

/** Composition root for the routines UI: what it borrows from computer, connectors, credentials. */
export function RoutinesPorts({ children }: { children: ReactNode }) {
  return <RoutinesUiProvider ports={ports}>{children}</RoutinesUiProvider>;
}
