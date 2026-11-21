import { useRoutineNavigation } from "../shell/navigation.ts";
import { RoutineDialog } from "./RoutineDialog.tsx";

// One host preserves the source view; settings temporarily yield the modal layer to this form.
export function RoutineOverlay() {
  const { routineOverlay, closeRoutineDialog, routinesChanged } = useRoutineNavigation();
  if (!routineOverlay) return null;
  return (
    <RoutineDialog
      key={routineOverlay.key}
      id={routineOverlay.id}
      botId={routineOverlay.botId}
      initial={routineOverlay.initial}
      close={() => closeRoutineDialog(routineOverlay.key)}
      changed={routinesChanged}
    />
  );
}
