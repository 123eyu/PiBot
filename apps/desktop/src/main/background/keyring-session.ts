import { secretStorageReason } from "@pibot/secrets";
import type { createKeyringSessionGate } from "./keyring-recovery.ts";

type SessionEvent =
  | "lock-screen"
  | "unlock-screen"
  | "user-did-resign-active"
  | "user-did-become-active"
  | "resume";

/** Wake probes are read-only, coalesced and owned by the same lifetime as the session listeners. */
export function watchKeyringSession(deps: {
  platform: NodeJS.Platform;
  monitor: {
    on(event: SessionEvent, listener: () => void): unknown;
    off(event: SessionEvent, listener: () => void): unknown;
  };
  gate: ReturnType<typeof createKeyringSessionGate>;
  probe(): Promise<boolean>;
  signal: AbortSignal;
  log(reason: string): void;
}) {
  let closed = false;
  let probing: Promise<void> | undefined;
  const resume = () => {
    if (closed || deps.signal.aborted) return;
    try {
      deps.gate.resume();
    } catch {
      // A missing OS session signal is not permission to initialize its native key provider.
      deps.log("session_state_unavailable");
      return;
    }
    if (probing) return;
    // The secure-storage adapter supplies its existing eight-second deadline and native queue.
    // Never replay an import or credential write when the machine wakes.
    probing = Promise.resolve()
      .then(() => {
        if (!closed && !deps.signal.aborted) return deps.probe();
      })
      .then(
        (available) => {
          if (!closed) deps.log(available ? "available" : "secrets_unavailable");
        },
        (error) => {
          if (!closed) deps.log(secretStorageReason(error));
        },
      )
      .finally(() => {
        probing = undefined;
      });
  };
  const listeners: [SessionEvent, () => void][] = [["resume", resume]];
  if (deps.platform === "darwin")
    listeners.push(
      ["lock-screen", () => deps.gate.inactive()],
      ["user-did-resign-active", () => deps.gate.inactive()],
      ["unlock-screen", () => deps.gate.active()],
      ["user-did-become-active", () => deps.gate.active()],
    );
  const detach = () => {
    if (closed) return;
    closed = true;
    for (const [event, listener] of listeners) deps.monitor.off(event, listener);
    deps.signal.removeEventListener("abort", detach);
  };
  if (!deps.signal.aborted) {
    for (const [event, listener] of listeners) deps.monitor.on(event, listener);
    deps.signal.addEventListener("abort", detach, { once: true });
  } else closed = true;
  return async () => {
    detach();
    await probing;
  };
}
