import type { TranslationKey } from "@pibot/i18n";

/**
 * The only strings the first frame draws (starting page and cached screen). The renderer's
 * first paint used to evaluate both full translation tables and, through them, the shared zod /
 * protocol chunk (~1.7 MB of script) before anything appeared. The GUI main process reads these
 * from @pibot/i18n and hands them over with the display snapshot, so the text still comes from
 * the one translation source.
 */
export const STARTUP_LABEL_KEYS = [
  "activity.routines",
  "appMenu.profile",
  "appMenu.title",
  "attachments.menu",
  "audit.title",
  "brain.starting",
  "chat.inputHint",
  "chat.noMoreHistory",
  "chat.placeholder",
  "chat.send",
  "chat.sendOptions",
  "chat.you",
  "common.search",
  "sidebar.chats",
  "sidebar.mainBot",
  "startup.cached",
  "startup.connecting",
  "startup.connectingPhase",
  "startup.readonly",
  "startup.refreshing",
  "startup.startingPhase",
  "startup.step.capabilities",
  "startup.step.network",
  "startup.step.recovery",
  "startup.step.services",
  "workspace.auditShort",
  "workspace.connectApps",
  "workspace.connectHint",
  "workspace.empty",
  "workspace.inbox",
  "workspace.inboxShort",
  "workspace.messageToday",
  "workspace.new",
  "workspace.newTopic",
  "workspace.routinesShort",
  "workspace.search",
  "workspace.sectionMenu",
  "workspace.unreadLabel",
] as const satisfies readonly TranslationKey[];
export type StartupLabelKey = (typeof STARTUP_LABEL_KEYS)[number];
export type StartupLabels = Readonly<Record<StartupLabelKey, string>>;
export type StartupLabelTables = Readonly<{ zh: StartupLabels; en: StartupLabels }>;
export type StartupTranslate = (
  key: StartupLabelKey,
  vars?: Readonly<Record<string, string | number>>,
) => string;

/** Same placeholder rule as @pibot/i18n `t`; none of these keys has plural forms. */
export function startupTranslator(labels: StartupLabels): StartupTranslate {
  return (key, vars) =>
    labels[key].replace(/\{(\w+)\}/g, (placeholder: string, name: string) =>
      vars && Object.hasOwn(vars, name) ? String(vars[name]) : placeholder,
    );
}

export function pickStartupLabels(table: Readonly<Record<StartupLabelKey, string>>): StartupLabels {
  return Object.fromEntries(STARTUP_LABEL_KEYS.map((key) => [key, table[key]])) as StartupLabels;
}

/** Trust boundary for the preload: exact keys, bounded plain strings. */
export function parseStartupLabels(value: unknown): StartupLabelTables | null {
  if (!value || typeof value !== "object") return null;
  const tables: Partial<Record<"zh" | "en", StartupLabels>> = {};
  for (const language of ["zh", "en"] as const) {
    const table = (value as Record<string, unknown>)[language];
    if (!table || typeof table !== "object") return null;
    const entries = Object.entries(table);
    if (entries.length !== STARTUP_LABEL_KEYS.length) return null;
    for (const key of STARTUP_LABEL_KEYS) {
      const text = (table as Record<string, unknown>)[key];
      if (typeof text !== "string" || text.length > 400) return null;
    }
    tables[language] = table as StartupLabels;
  }
  return tables as StartupLabelTables;
}
