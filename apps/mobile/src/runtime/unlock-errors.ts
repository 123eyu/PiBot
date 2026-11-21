import type { LocalAuthenticationError } from "expo-local-authentication";

/**
 * Native unlock results → the app's error codes (pure, so the notify probe checks it in Node):
 * - `unlock_cancelled`: the person (or the system) dismissed the prompt; nothing was sent and no
 *   error is shown (runtime/use-action.ts).
 * - `unlock_unavailable`: no biometrics and no screen lock, so nothing to verify with; the action
 *   is refused with an explanation instead of being allowed.
 * - `unlock_locked`: too many failed attempts; the system locks biometrics for a while.
 * - `unlock_denied`: verification failed.
 */
export function unlockError(error: LocalAuthenticationError) {
  switch (error) {
    case "user_cancel":
    case "system_cancel":
    case "app_cancel":
    case "user_fallback":
      return "unlock_cancelled";
    case "not_enrolled":
    case "not_available":
    case "passcode_not_set":
      return "unlock_unavailable";
    case "lockout":
      return "unlock_locked";
    default:
      return "unlock_denied";
  }
}
