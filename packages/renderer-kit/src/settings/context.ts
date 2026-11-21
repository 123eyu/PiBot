import type { createTranslator, Language } from "@pibot/i18n";
import type { NetworkProxyConfig, Settings } from "@pibot/protocol";
import { createContext, useContext } from "react";

export interface SettingsContextValue {
  /** undefined until the first settings.get after the brain is ready. */
  settings: Settings | undefined;
  network: NetworkProxyConfig | undefined;
  update(patch: Partial<Settings>): Promise<void>;
  language: Language;
  theme: Settings["theme"];
  t: ReturnType<typeof createTranslator>;
}

/** Filled by the desktop `SettingsProvider`. */
export const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings must be used inside SettingsProvider");
  return value;
}

/** Shorthand for the translator bound to the current UI language. */
export function useT() {
  return useSettings().t;
}
