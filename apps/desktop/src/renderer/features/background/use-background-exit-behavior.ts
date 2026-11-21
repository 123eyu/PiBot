import { useEffect, useState } from "react";
import { BackgroundSettingsState, initialBackgroundSnapshot } from "./background-settings-state.ts";

/** Read the owner's preferences through the same bounded lifecycle as the settings page. */
export function useBackgroundExitBehavior(): "stop" | "continue" | undefined {
  const bridge = window.pibot?.background;
  const [snapshot, setSnapshot] = useState(initialBackgroundSnapshot);
  useEffect(() => {
    setSnapshot(initialBackgroundSnapshot);
    if (!bridge) return;
    const controller = new BackgroundSettingsState(bridge);
    const off = controller.subscribe(setSnapshot);
    void controller.refresh();
    return () => {
      off();
      controller.dispose();
    };
  }, [bridge]);
  return snapshot.known && !snapshot.failed ? snapshot.state?.preferences.exitBehavior : undefined;
}
