import { type ShellDialog, useNavigation } from "@pibot/renderer-kit";
import { useCallback } from "react";

export interface RoutineOverlay {
  key: string;
  id?: string;
  botId?: string;
  /** New-task prefill, e.g. 「做成调度任务」 from a skill. */
  initial?: RoutinePrefill;
}
export interface RoutinePrefill {
  name?: string;
  instructions?: string;
}

const owner = "routines";
type Dialog = ShellDialog & { state: Omit<RoutineOverlay, "key"> };
const isRoutineDialog = (dialog: ShellDialog | undefined): dialog is Dialog =>
  dialog?.owner === owner;

/** The routines page and task editor, on top of the shell's generic page/dialog/revision API. */
export function useRoutineNavigation() {
  const { openPage, dialog, showDialog, closeDialog, revisions, bumpRevision } = useNavigation();
  const openRoutines = useCallback(
    (routineId?: string, botId?: string, initial?: RoutinePrefill) => {
      if (!routineId) {
        openPage("routines");
        return;
      }
      const id = routineId === "new" ? undefined : routineId;
      // Repeated requests for the same task keep its draft and the original focus owner.
      showDialog((current) =>
        isRoutineDialog(current) &&
        current.state.id === id &&
        (id !== undefined || current.state.botId === botId) &&
        !initial
          ? current
          : {
              owner,
              key: crypto.randomUUID(),
              state: { id, botId, ...(initial && !id ? { initial } : {}) },
            },
      );
    },
    [openPage, showDialog],
  );
  const routinesChanged = useCallback(() => bumpRevision(owner), [bumpRevision]);
  const routineOverlay: RoutineOverlay | undefined = isRoutineDialog(dialog)
    ? { key: dialog.key, ...dialog.state }
    : undefined;
  return {
    openRoutines,
    routineOverlay,
    closeRoutineDialog: closeDialog,
    routineRevision: revisions[owner] ?? 0,
    routinesChanged,
  };
}
