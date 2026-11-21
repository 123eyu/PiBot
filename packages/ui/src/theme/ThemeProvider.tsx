import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";
import {
  getSystemTheme,
  resolveTheme,
  subscribeSystemTheme,
  type Theme,
  type ThemeSetting,
} from "./theme.ts";

interface ThemeContextValue {
  theme: ThemeSetting;
  resolvedTheme: Theme;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);
const serverTheme = (): Theme => "light";

export interface ThemeProviderProps {
  theme?: ThemeSetting;
  children: ReactNode;
}

export function ThemeProvider({ theme = "system", children }: ThemeProviderProps) {
  const systemTheme = useSyncExternalStore(subscribeSystemTheme, getSystemTheme, serverTheme);
  const resolvedTheme = resolveTheme(theme, systemTheme === "dark");
  // Apply cached appearance before the first paint, including the brain startup screen.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute("data-theme");
    root.setAttribute("data-theme", resolvedTheme);
    return () => {
      if (previous === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", previous);
    };
  }, [resolvedTheme]);
  return <ThemeContext.Provider value={{ theme, resolvedTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}
