/**
 * Session signals are a conservative preflight, not proof that the keychain is unlocked. Only a
 * login launch waits out the grace and stability window: a GUI start, an update restart or a
 * recovery relaunch happens inside a session the user is already using.
 */
export function createKeyringSessionGate(deps: {
  platform: NodeJS.Platform;
  login: boolean;
  idle(): string;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const started = now();
  let stableAt: number | undefined;
  let inactive = false;
  let woke = false;
  return {
    inactive() {
      inactive = true;
      stableAt = undefined;
    },
    active() {
      inactive = false;
      stableAt = undefined;
    },
    resume() {
      // Sleep can lose the matching activation event, so a wake drops the stale inactive bit and
      // every later check re-reads the session; a wake alone is not proof the screen is unlocked.
      inactive = false;
      woke = deps.platform === "darwin";
      stableAt = undefined;
    },
    ready() {
      if (deps.platform === "win32") return true;
      const state = deps.idle();
      // Outside a login launch nothing suggests the session is still forming, so "unknown" (no
      // idle detection on this desktop) does not block; a locked session still does. Right after
      // a macOS wake "unknown" is not trusted until the session reads active or idle once.
      const settled =
        deps.login || woke ? state === "active" || state === "idle" : state !== "locked";
      if (woke && settled) woke = false;
      if (inactive || !settled) {
        stableAt = undefined;
        return false;
      }
      if (!deps.login) return true;
      stableAt ??= now();
      return now() - started >= 30_000 && now() - stableAt >= 3000;
    },
  };
}

export type KeyringRestartResult = "committed" | "deferred" | "unsupported";

/**
 * Budget survives relaunch; a busy writer defers without consuming a restart attempt. Every
 * healthy report starts a new epoch, so a preparation that began before storage recovered can
 * no longer commit (`current()` is re-checked at the commit point).
 */
export function createKeyringRecovery(deps: {
  attempt: number;
  restart(next: number, current: () => boolean): Promise<KeyringRestartResult>;
  log(event: string, attempt: number): void;
  /** Ask the user to restart by hand; false withdraws the request once storage recovered. */
  notice(needed: boolean): void;
  delays?: readonly number[];
  deferMs?: number;
  /** How long automatic recovery may keep deferring before the user is asked. */
  noticeAfterMs?: number;
  now?: () => number;
}) {
  const delays = deps.delays ?? [30_000, 120_000, 600_000];
  const now = deps.now ?? Date.now;
  let attempt = deps.attempt;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let closed = false;
  let failed = false;
  let epoch = 0;
  let deferredSince: number | undefined;
  let noticed = false;
  // This platform cannot restart its owner itself; only the user can, until storage recovers.
  let manual = false;
  const notice = (needed: boolean) => {
    if (noticed === needed) return;
    noticed = needed;
    deps.notice(needed);
  };
  const arm = (delay: number) => {
    timer = setTimeout(() => {
      timer = undefined;
      if (closed || !failed) return;
      running = true;
      const current = epoch;
      void deps
        .restart(attempt + 1, () => !closed && failed && epoch === current)
        .then(
          (result) => {
            running = false;
            if (result === "committed") {
              closed = true;
              return;
            }
            if (closed || !failed) return;
            // Recovered and failed again during the preparation: the new fault schedules afresh.
            if (epoch !== current) return schedule();
            if (result === "unsupported") {
              manual = true;
              deps.log("keyring_restart_unsupported", attempt);
              notice(true);
              return;
            }
            deferredSince ??= now();
            if (now() - deferredSince >= (deps.noticeAfterMs ?? 120_000)) notice(true);
            arm(deps.deferMs ?? 15_000);
          },
          () => {
            running = false;
            closed = true;
            deps.log("keyring_restart_drain_failed", attempt);
            notice(true);
          },
        );
    }, delay);
    timer.unref?.();
  };
  function schedule() {
    if (closed || manual || timer || running || !failed) return;
    if (attempt >= delays.length) {
      deps.log("keyring_restart_exhausted", attempt);
      notice(true);
      return;
    }
    deps.log("keyring_restart_scheduled", attempt + 1);
    arm(delays[attempt] ?? 600_000);
  }
  return {
    failed() {
      failed = true;
      schedule();
    },
    healthy() {
      failed = false;
      manual = false;
      attempt = 0;
      epoch++;
      deferredSince = undefined;
      clearTimeout(timer);
      timer = undefined;
      notice(false);
    },
    dispose() {
      closed = true;
      clearTimeout(timer);
    },
  };
}
