import { abortable } from "@pibot/brain/kit";
import type { CredentialService } from "./accounts/credentials-service.ts";
import type { UserSecretService } from "./secrets/user-secret-service.ts";

/** Startup and first consumers share one owner; cancelling a waiter never retires its work. */
export function credentialInitialization(
  secrets: UserSecretService,
  credentials: CredentialService,
  signal: AbortSignal,
) {
  let complete = false;
  /**
   * Claude review 2026-11-12: before this gate a failed or locked keyring left Pi Bot usable (only
   * the
   * secret-dependent tool gates stayed locked). Content waits for the first attempt only; after it
   * failed, waiters are released as before instead of every request failing after 30 s.
   */
  let attempted = false;
  let work: Promise<void> | undefined;
  const ensure = () => {
    signal.throwIfAborted();
    work ??= (async () => {
      await secrets.ready(signal);
      signal.throwIfAborted();
      await credentials.migrateNotes(AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
      signal.throwIfAborted();
      complete = true;
    })().finally(() => {
      work = undefined;
      attempted = true;
    });
    return work;
  };
  return {
    idle: () => !work && secrets.idle,
    async ready(parent: AbortSignal) {
      parent.throwIfAborted();
      signal.throwIfAborted();
      if (!complete && !attempted) {
        try {
          await abortable(ensure(), AbortSignal.any([parent, signal, AbortSignal.timeout(30_000)]));
        } catch {
          parent.throwIfAborted();
          signal.throwIfAborted();
          // The keyring stayed unavailable: release content, keep tool gates locked (pre-A58).
          attempted = true;
        }
        parent.throwIfAborted();
        signal.throwIfAborted();
      }
    },
    async settled() {
      await Promise.allSettled([work, secrets.settled()]);
    },
  };
}
