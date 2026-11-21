import { resolveTheme, type ThemeSetting } from "@pibot/ui";
import { tokens } from "@pibot/ui/tokens";
import { type CSSProperties, useSyncExternalStore } from "react";

const query = "(prefers-color-scheme: dark)";
const current = () => window.matchMedia(query).matches;
const server = () => false;
function subscribe(listener: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

/** Explicit light tokens also isolate a light preview from a dark live root. */
export function useStartupTheme(setting: ThemeSetting): CSSProperties {
  const dark = useSyncExternalStore(subscribe, current, server);
  const theme = resolveTheme(setting, dark);
  return {
    ...Object.fromEntries(Object.entries(tokens[theme]).map(([key, value]) => [`--${key}`, value])),
    colorScheme: theme,
  } as CSSProperties;
}
