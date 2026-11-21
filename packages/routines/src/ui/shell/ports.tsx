import type { TranslationKey } from "@pibot/i18n";
import type { ComputerApp, EventPayloads, MethodResults } from "@pibot/protocol";
import { type Peer, useRpc, useRpcEvent } from "@pibot/renderer-kit";
import { type ComponentType, createContext, type ReactNode, useContext, useState } from "react";

export interface ConnectorPage<T> {
  value?: { items: T[]; nextCursor: string | null };
  loading: boolean;
  error?: TranslationKey;
  refresh(): void;
  previous?: () => void;
  next?: () => void;
}

/**
 * What the routines UI borrows from other parts of the app. Capabilities never import
 * each other's UI, so the desktop composition root supplies these: computer use (app list),
 * connectors (paged connector reads), credentials (saved login sites) and the host platform.
 * When computer, connectors and credentials become capability packages, their own `/ui` entries
 * provide these adapters instead of the desktop app.
 */
export interface RoutinesUiPorts {
  platform: string;
  useExitBehavior(): "stop" | "continue" | undefined;
  /** Sites with a saved account this Bot may use (login pre-authorization). */
  useSavedLoginSites(botId: string | undefined): readonly string[];
  useInstalledApps(enabled: boolean): { data?: MethodResults["computer.installedApps"] };
  AppListEditor: ComponentType<{
    apps: ComputerApp[];
    onChange(apps: ComputerApp[]): void;
    disabled?: boolean;
  }>;
  useConnectorPage<T>(
    load: (
      peer: Peer,
      signal: AbortSignal,
      cursor?: string,
    ) => Promise<{ items: T[]; nextCursor: string | null }>,
    snapshot: number,
  ): ConnectorPage<T>;
  ConnectorFeedback: ComponentType<{
    loading: boolean;
    error?: TranslationKey;
    retry(): void;
  }>;
  ConnectorPagination: ComponentType<{
    previous?: () => void;
    next?: () => void;
    disabled: boolean;
  }>;
  /** The work receipt of a finished run (records of the app, not the model's account). */
  RunReceipt: ComponentType<{ runId: string }>;
}

type Power = EventPayloads["power.state"];
const Context = createContext<{ ports: RoutinesUiPorts; power?: Power } | undefined>(undefined);

export function RoutinesUiProvider({
  ports,
  children,
}: {
  ports: RoutinesUiPorts;
  children: ReactNode;
}) {
  const { peer } = useRpc();
  // The brain emits power.state when it changes; keep the latest for pages mounted later. A value
  // from a previous brain connection is never shown for the current one.
  const [power, setPower] = useState<{ peer: Peer; value: Power }>();
  useRpcEvent("power.state", (value) => {
    if (peer) setPower({ peer, value });
  });
  return (
    <Context.Provider value={{ ports, power: power?.peer === peer ? power.value : undefined }}>
      {children}
    </Context.Provider>
  );
}

function useRoutinesContext() {
  const value = useContext(Context);
  if (!value) throw new Error("RoutinesUiProvider is required");
  return value;
}

export function useRoutinesPorts(): RoutinesUiPorts {
  return useRoutinesContext().ports;
}

/** Latest power and keep-awake state from the brain (routines' `power.state` event). */
export function useRoutinePower(): Power | undefined {
  return useRoutinesContext().power;
}
