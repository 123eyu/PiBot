import type { TranslationKey } from "@pibot/i18n";

/**
 * A scheduled task's topic is titled after the task (maintainers 2026-10-21: one topic per task, named
 * 「调度任务：xxxx」). The stored title is the task name, kept in sync on rename; the prefix is
 * added at display time so it follows the UI language.
 */
export function routineTopicTitle(
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
  name: string,
): string {
  return t("routines.topicTitle", { name });
}
