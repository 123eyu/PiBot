/**
 * Routines copy in both languages. Pure data, so the `@pibot/i18n` aggregate table can
 * spread it without depending on the routines implementation; the `zh` and `en` tables must keep
 * the same keys (the aggregate's `satisfies TranslationTable` checks it).
 */
export { routinesEn } from "./en.ts";
export { routineProposalsEn, routineProposalsZh } from "./proposals.ts";
export { routinesZh } from "./zh.ts";
