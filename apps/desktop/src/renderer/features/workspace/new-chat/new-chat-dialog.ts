import type { ShellDialog } from "@pibot/renderer-kit";

/** Maintainers 2026-11-13: the sidebar ＋ menu opens these as dialogs over the current screen. */
export const NEW_CHAT_DIALOG = "new-chat";
export type NewChatDialogKind = "bot" | "group";
export type RoleImportTarget = { kind: "role" | "group"; id: string; version: number };

export function newChatDialog(kind: NewChatDialogKind, target?: RoleImportTarget): ShellDialog {
  return {
    owner: NEW_CHAT_DIALOG,
    key: crypto.randomUUID(),
    state: target ? { kind, target } : kind,
  };
}
