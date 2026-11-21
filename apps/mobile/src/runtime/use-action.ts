import { useEffect, useRef, useState } from "react";
import type { MobileKey } from "../i18n/messages.ts";
import { errorKey, unlockCancelled } from "./errors.ts";

export function useAction(scope: string | undefined, connection?: unknown) {
  const [error, setError] = useState<MobileKey>();
  const [busy, setBusy] = useState(false);
  const owner = useRef<AbortController>(new AbortController());
  const running = useRef(false);
  const refresh = useRef<((signal: AbortSignal) => Promise<unknown>) | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope and connection define cancellation ownership.
  useEffect(() => {
    const controller = new AbortController();
    owner.current = controller;
    setError(undefined);
    running.current = false;
    refresh.current = undefined;
    setBusy(false);
    return () => controller.abort();
  }, [scope, connection]);
  async function run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (running.current) return undefined;
    const controller = owner.current;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      return await operation(controller.signal);
    } catch (cause) {
      // Dismissing the unlock prompt is the person's own choice and nothing was sent: no error.
      if (!controller.signal.aborted && !unlockCancelled(cause)) setError(errorKey(cause));
      return undefined;
    } finally {
      if (!controller.signal.aborted) {
        running.current = false;
        setBusy(false);
        const next = refresh.current;
        refresh.current = undefined;
        if (next) void run(next);
      }
    }
  }
  return {
    error,
    busy,
    run,
    setError,
    read(operation: (signal: AbortSignal) => Promise<unknown>) {
      if (running.current) {
        refresh.current = operation;
        return Promise.resolve(undefined);
      }
      return run(operation);
    },
  };
}
