import { piHistoryPrompts } from "./prompts/pi-history.ts";
// Exact persisted defaults from git history; do not normalize user-authored personas.
export const historicalPiPersonas = [
  // 2732deb3: the first default.
  piHistoryPrompts.historicalPiPersonas.item1,
  piHistoryPrompts.historicalPiPersonas.item2,
  // 85bb098f / 0f6d1969: remove milestone wording, then add runtime identity separately.
  piHistoryPrompts.historicalPiPersonas.item3,
  piHistoryPrompts.historicalPiPersonas.item4,
  // c1c24542: uploaded attachments.
  piHistoryPrompts.historicalPiPersonas.item5,
  piHistoryPrompts.historicalPiPersonas.item6,
  // 76364fc0 / 062ab4c0: first tools, retained later.
  piHistoryPrompts.historicalPiPersonas.item7,
  piHistoryPrompts.historicalPiPersonas.item8,
] as const;
