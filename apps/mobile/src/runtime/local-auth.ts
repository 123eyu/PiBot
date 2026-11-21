import * as Authentication from "expo-local-authentication";
import { AppState, Platform } from "react-native";
import { nativeWait } from "./native-wait.ts";
import { unlockError } from "./unlock-errors.ts";

/**
 * Phone-side unlock (Face ID / fingerprint / passcode) before an action that removes a safeguard
 * or cannot be undone: allowing a dangerous approval, turning YOLO on, restoring files, taking
 * over the Bot browser, widening permissions, deleting a memory, removing a group member. The
 * computer cannot verify it; it only keeps a stolen unlocked phone from doing these with one tap.
 * Failures throw the codes described in unlock-errors.ts.
 */
export async function confirmLocally(
  promptMessage: string,
  cancelLabel: string,
  signal: AbortSignal,
) {
  // NONE = no passcode, PIN, pattern or biometrics: refuse rather than silently allow. SECRET
  // (screen lock only) still works: the device-owner policy falls back to the passcode when no
  // face or fingerprint is enrolled.
  const level = await nativeWait(Authentication.getEnrolledLevelAsync(), signal, 10_000);
  signal.throwIfAborted();
  if (level === Authentication.SecurityLevel.NONE) throw new Error("unlock_unavailable");
  const result = await nativeWait(
    Authentication.authenticateAsync({ promptMessage, cancelLabel, disableDeviceFallback: false }),
    signal,
    60_000,
  );
  signal.throwIfAborted();
  if (!result.success) throw new Error(unlockError(result.error));
}

/** Capability grants require enrolled biometrics, including when the OS offers a device PIN. */
export async function confirmBiometrically(
  promptMessage: string,
  cancelLabel: string,
  parent: AbortSignal,
) {
  if (AppState.currentState === "background") throw new Error("unlock_cancelled");
  const foreground = new AbortController();
  const state = AppState.addEventListener("change", (next) => {
    // The system prompt itself can make the app inactive without sending it to the background.
    if (next === "background") foreground.abort(new Error("unlock_cancelled"));
  });
  const lifetime = AbortSignal.any([parent, foreground.signal]);
  try {
    const enrolled = await nativeWait(Authentication.getEnrolledLevelAsync(), lifetime, 10_000);
    lifetime.throwIfAborted();
    if (enrolled !== Authentication.SecurityLevel.BIOMETRIC_STRONG)
      throw new Error("unlock_unavailable");
    await promptBiometrics(promptMessage, cancelLabel, lifetime);
  } finally {
    state.remove();
  }
}

async function promptBiometrics(promptMessage: string, cancelLabel: string, parent: AbortSignal) {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(60_000)]);
  const cancel = () => {
    if (Platform.OS === "android")
      void Authentication.cancelAuthenticate().catch(() => {
        // Android may already have closed the prompt. The aborted action cannot send a write.
      });
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const result = await nativeWait(
      Authentication.authenticateAsync({
        promptMessage,
        cancelLabel,
        fallbackLabel: "",
        disableDeviceFallback: true,
        biometricsSecurityLevel: "strong",
        requireConfirmation: true,
      }),
      signal,
      60_000,
    );
    signal.throwIfAborted();
    if (!result.success) throw new Error(unlockError(result.error));
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
