import type { ShellDialog } from "@pibot/renderer-kit";

export const PROJECT_MEMORY_DIALOG = "project-memory";
export type ProjectMemoryDialogState = { projectId: string | null; name?: string };

/** Notices carry a scoped id without the folder label available to the folder menu. */
export function projectMemoryDialog(projectId: string | null, name?: string): ShellDialog {
  return {
    owner: PROJECT_MEMORY_DIALOG,
    key: crypto.randomUUID(),
    state: { projectId, name } satisfies ProjectMemoryDialogState,
  };
}
