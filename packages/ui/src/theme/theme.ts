export type Theme = "light" | "dark";
export type ThemeSetting = Theme | "system";

export function resolveTheme(setting: ThemeSetting, systemDark: boolean): Theme {
  return setting === "system" ? (systemDark ? "dark" : "light") : setting;
}

export const colorSchemeQuery = "(prefers-color-scheme: dark)";

export function getSystemTheme(): Theme {
  return typeof window !== "undefined" && window.matchMedia(colorSchemeQuery).matches
    ? "dark"
    : "light";
}

export function subscribeSystemTheme(
  listener: () => void,
  media: Pick<MediaQueryList, "addEventListener" | "removeEventListener"> = window.matchMedia(
    colorSchemeQuery,
  ),
): () => void {
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
