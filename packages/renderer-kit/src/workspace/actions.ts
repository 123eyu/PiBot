import type { TranslationKey } from "@pibot/i18n";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import { useCallback, useEffect, useRef, useState } from "react";

export function actionError(error: unknown): TranslationKey {
  return error instanceof RpcError && error.code === RpcErrorCodes.methodNotFound
    ? "workspace.unavailable"
    : error instanceof RpcError && error.code === RpcErrorCodes.timeout
      ? "workspace.createUncertain"
      : "workspace.failed";
}

export async function optional<T>(operation: Promise<T>): Promise<T | undefined> {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof RpcError && error.code === RpcErrorCodes.methodNotFound) return undefined;
    throw error;
  }
}

// RPC timeout/unmount only ends UI waiting; it cannot revoke a server-side accepted mutation.
export function useAction() {
  const active = useRef(true);
  const lifetime = useRef(new AbortController());
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKey>();
  useEffect(() => {
    active.current = true;
    lifetime.current = new AbortController();
    return () => {
      active.current = false;
      lifetime.current.abort();
    };
  }, []);
  const run = useCallback(
    async <T>(
      operation: (signal: AbortSignal) => Promise<T>,
      failure: (error: unknown) => TranslationKey = actionError,
    ): Promise<T | undefined> => {
      if (locked.current) return undefined;
      locked.current = true;
      setBusy(true);
      setError(undefined);
      try {
        const result = await operation(lifetime.current.signal);
        return active.current ? result : undefined;
      } catch (error) {
        if (active.current && !lifetime.current.signal.aborted) setError(failure(error));
        return undefined;
      } finally {
        locked.current = false;
        if (active.current) setBusy(false);
      }
    },
    [],
  );
  return { busy, error, setError, run };
}
