import type { TranslationKey } from "@pibot/i18n";
import type { Peer } from "@pibot/renderer-kit";
import { type ComponentType, createContext, type ReactNode, useContext } from "react";

/** Borrowed app-shell pieces, supplied by desktop; never import another capability's UI. */
export interface SkillsUiPorts {
  BrowserPane: ComponentType<{
    botId: string;
    botName: string;
    peer: Peer | null;
    wide: boolean;
    teaching?: boolean;
  }>;
  PanelMenu: ComponentType<{
    label: string;
    items: readonly {
      id: string;
      label: string;
      run(): void;
      disabled?: boolean;
      danger?: boolean;
    }[];
    trigger?: ReactNode;
    width?: number;
    disabled?: boolean;
  }>;
  useRoutineNavigation(): {
    openRoutines(id: "new", botId: string, initial: { name: string; instructions: string }): void;
  };
  /** The connections page's MCP list as choices for one Bot / group (「从连接选择」). */
  useConnectionChoices(target: { kind: "bot" | "group"; id: string }): {
    rows: readonly { id: string; name: string; description: string; on: boolean }[];
    loading: boolean;
    error?: TranslationKey;
    retry(): void;
    /** Writes the rows whose wanted state differs; resolves to an error key when one failed. */
    apply(wanted: ReadonlyMap<string, boolean>): Promise<TranslationKey | undefined>;
  };
}
const Context = createContext<SkillsUiPorts | undefined>(undefined);
export function SkillsUiProvider({
  ports,
  children,
}: {
  ports: SkillsUiPorts;
  children: ReactNode;
}) {
  return <Context.Provider value={ports}>{children}</Context.Provider>;
}
export function useSkillsPorts(): SkillsUiPorts {
  const value = useContext(Context);
  if (!value) throw new Error("SkillsUiProvider is required");
  return value;
}
export function useSkillRoutineNavigation() {
  return useSkillsPorts().useRoutineNavigation();
}
