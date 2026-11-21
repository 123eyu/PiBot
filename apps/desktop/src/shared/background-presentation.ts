import type { TranslationKey } from "@pibot/i18n";
import type { IndependentBackgroundState } from "@pibot/protocol";

export type BackgroundPresentation = Pick<IndependentBackgroundState, "lifecycle" | "brainPhase">;

/**
 * Tray status words (menu of 2026-10-28): what the user can rely on, not how the owner gets
 * there. Standby and its preparation still count as running because routines still fire; an
 * absent phase keeps the old owner's meaning of ready. `null` is a tray whose state has not been
 * reported yet.
 */
export function trayStatusKeys(state: BackgroundPresentation | null): {
  state: TranslationKey;
  reason?: TranslationKey;
} {
  if (!state) return { state: "tray.state.starting" };
  switch (state.lifecycle) {
    case "starting":
      return { state: "tray.state.starting" };
    case "stopping":
      return { state: "tray.state.stopping" };
    case "stopped":
      return { state: "tray.state.stopped" };
    case "failed":
      return { state: "tray.state.error", reason: "tray.error.failed" };
    case "unsupported":
      return { state: "tray.state.error", reason: "tray.error.unsupported" };
    case "ready":
      if (state.brainPhase === "unavailable")
        return { state: "tray.state.error", reason: "tray.error.unavailable" };
      return {
        state: state.brainPhase === "waking" ? "tray.state.starting" : "tray.state.running",
      };
  }
}

export function backgroundPreferencesEditable(state: BackgroundPresentation) {
  return (
    state.lifecycle === "ready" &&
    (!state.brainPhase || state.brainPhase === "working" || state.brainPhase === "standby")
  );
}

/**
 * The owner calls this on GUI attach/detach, settings changes and accepted preference updates.
 * Settings has a single tray switch, which applies while the desktop is open. Once the
 * desktop has quit and the helper keeps scheduling, the tray always shows: it is the only sign
 * that work is still running and the only place to stop it. The older `showTrayWhenBackground`
 * preference may still be stored; nothing in the UI can change it any more, so it is not read.
 */
export function shouldShowOwnerTray(options: { guiConnected: boolean; showTrayIcon: boolean }) {
  return options.guiConnected ? options.showTrayIcon : true;
}
