export function resolveCredentialLanguage(
  language: "zh" | "en" | "system",
  locale: string,
): "zh" | "en" {
  return language === "system" ? (locale.toLowerCase().startsWith("zh") ? "zh" : "en") : language;
}
