import { bounded, ComputerError } from "../core/errors.ts";

/** Native futures never receive the caller's signal: cancelling a future is not a drain receipt. */
export function createCuaLifetime(
  driver: { shutdown(): Promise<void>; uniffiDestroy?(): void },
  timeoutMs: number,
) {
  const pending = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  let retired = false;

  const track = <T>(run: () => Promise<T>): Promise<T> => {
    const operation = Promise.resolve().then(run);
    pending.add(operation);
    void operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    return operation;
  };
  const shutdown = (): Promise<void> => {
    retired = true;
    closing ??= bounded("cua.drain_unconfirmed", timeoutMs, undefined, async () => {
      // shutdown seals native admission; existing calls must also settle before reuse is safe.
      await driver.shutdown();
      await Promise.allSettled([...pending]);
      driver.uniffiDestroy?.();
    }).catch(() => {
      throw new ComputerError("driver_error", "cua.drain_unconfirmed");
    });
    return closing;
  };
  return {
    get retired() {
      return retired;
    },
    async call<T>(
      name: string,
      signal: AbortSignal | undefined,
      run: () => Promise<T>,
    ): Promise<T> {
      if (retired) throw new ComputerError("driver_error", "cua_client_retired");
      try {
        return await bounded(name, timeoutMs, signal, () =>
          track(() => {
            if (signal?.aborted || retired) throw new ComputerError("cancelled", name);
            return run();
          }),
        );
      } catch (error) {
        if (
          error instanceof ComputerError &&
          (error.code === "timeout" || error.code === "cancelled")
        )
          await shutdown();
        throw error;
      }
    },
    async drain() {
      if (closing) return closing;
      await bounded("cua.drain_unconfirmed", timeoutMs, undefined, () =>
        Promise.allSettled([...pending]),
      );
    },
    shutdown,
  };
}
