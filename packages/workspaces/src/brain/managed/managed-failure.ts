export function isManagedCleanupFailure(error: unknown) {
  return (
    !!error && typeof error === "object" && "reason" in error && error.reason === "cleanup_failed"
  );
}

/** Secondary bookkeeping failures must not turn an uncertain drain into a releasable error. */
export function preserveManagedFailure(error: unknown, actions: (() => void)[]): unknown {
  const errors = [error];
  for (const action of actions) {
    try {
      action();
    } catch (secondary) {
      if (!isManagedCleanupFailure(error)) throw secondary;
      errors.push(secondary);
    }
  }
  return errors.length === 1
    ? error
    : Object.assign(
        new AggregateError(errors, "Managed operation cleanup failed", { cause: error }),
        {
          reason: "cleanup_failed",
        },
      );
}

/** A notification in finally must preserve the same failure contract as DB/audit settlement. */
export function notifyManagedFailure(error: unknown, notify: () => void) {
  const result = preserveManagedFailure(error, [notify]);
  if (result !== error) throw result;
}
