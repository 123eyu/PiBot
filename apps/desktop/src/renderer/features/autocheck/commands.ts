import { AutoCheckCommandsSchema } from "@pibot/protocol";
import type { useT } from "@pibot/renderer-kit";

/** Text area → 1–3 single-line commands (blank lines dropped); undefined when invalid. */
export function parseCommands(text: string): string[] | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = AutoCheckCommandsSchema.safeParse(lines);
  return parsed.success ? parsed.data : undefined;
}

/** "12 s" / "2 m 5 s" through the translation table. */
export function durationText(ms: number | undefined, t: ReturnType<typeof useT>) {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  return total < 60
    ? t("autoCheck.duration.seconds", { seconds: total })
    : t("autoCheck.duration.minutes", { minutes: Math.floor(total / 60), seconds: total % 60 });
}
