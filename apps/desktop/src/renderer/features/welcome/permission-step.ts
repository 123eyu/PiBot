import type { ComputerPermissions } from "@pibot/computer-use-contract/full";

/** Unsupported / limited hosts keep their explanation; only known unnecessary setup is omitted. */
export function canSkipPermissionStep(data: ComputerPermissions, platform: string | undefined) {
  if (data.platform !== platform) return false;
  // Maintainers 2026-11-13: Automation counts too; "unknown" means it could not be read, not denied.
  if (platform === "darwin")
    return (
      ["accessibility", "screen"].every((kind) =>
        data.items.some((item) => item.kind === kind && item.status === "granted"),
      ) &&
      !data.items.some(
        (item) =>
          item.kind === "automation" &&
          (item.status === "denied" || item.status === "not_determined"),
      )
    );
  return (
    platform === "linux" &&
    data.available &&
    !data.unavailableReason &&
    data.items
      .filter((item) => item.kind !== "automation")
      .every((item) => item.status === "granted" || item.status === "not_required")
  );
}

export const welcomeSteps = (omitPermissions: boolean) =>
  omitPermissions ? [0, 1, 2, 4] : [0, 1, 2, 3, 4];

/** A failed or slow status read must not block onboarding or assume permission was granted. */
export function readPermissionStep(
  platform: string | undefined,
  read: (signal: AbortSignal) => Promise<ComputerPermissions>,
  signal: AbortSignal,
  timeoutMs = 5_000,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (platform === "win32") return Promise.resolve(true);
  if (platform !== "darwin" && platform !== "linux") return Promise.resolve(false);
  return new Promise((resolve) => {
    const request = new AbortController();
    let settled = false;
    const finish = (skip: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      resolve(skip);
    };
    const cancel = () => {
      request.abort();
      finish(false);
    };
    const timer = setTimeout(cancel, timeoutMs);
    signal.addEventListener("abort", cancel, { once: true });
    // Promise wrapping also handles a synchronous transport failure without leaking the timer.
    void Promise.resolve()
      .then(() => {
        request.signal.throwIfAborted();
        return read(request.signal);
      })
      .then(
        (data) => finish(canSkipPermissionStep(data, platform)),
        () => finish(false),
      );
  });
}
