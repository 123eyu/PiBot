import type { Settings } from "@pibot/protocol-base";

export function resolvePersonaLanguage(
  language: Settings["language"],
  locale: string,
): "zh" | "en" {
  return language === "system" ? (locale.toLowerCase().startsWith("zh") ? "zh" : "en") : language;
}
