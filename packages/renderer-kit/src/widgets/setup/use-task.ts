import { useLayoutEffect, useRef, useState } from "react";
import { useRpc } from "../../rpc/context.ts";
import { useT } from "../../settings/context.ts";
import { SetupError } from "./setup-error.ts";

export function useTask(scope?: unknown) {
  const t = useT();
  const { peer } = useRpc();
  const lifetime = useRef({ peer, scope, active: true, locked: false });
  if (lifetime.current.peer !== peer || lifetime.current.scope !== scope)
    lifetime.current = { peer, scope, active: true, locked: false };
  const owner = lifetime.current;
  const current = () => owner.active && lifetime.current === owner;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Parameters<typeof t>[0]>();
  const [blocked, setBlocked] = useState(false);
  const [success, setSuccess] = useState<string>();
  useLayoutEffect(() => {
    owner.active = true;
    setBusy(false);
    setError(undefined);
    setSuccess(undefined);
    setBlocked(false);
    return () => {
      owner.active = false;
    };
  }, [owner]);
  async function run(action: () => Promise<void>) {
    if (!current() || owner.locked) return;
    owner.locked = true;
    setBusy(true);
    setError(undefined);
    setSuccess(undefined);
    try {
      await action();
    } catch (failure) {
      if (!current()) return;
      const key = failure instanceof SetupError ? failure.key : "setup.failed";
      setError(key);
      if (key === "models.noSecretStore") setBlocked(true);
    } finally {
      owner.locked = false;
      if (current()) setBusy(false);
    }
  }
  return {
    busy,
    isBusy: () => owner.locked,
    blocked,
    error: error ? t(error) : undefined,
    /** The untranslated key, for a caller that offers a next step for one kind of failure. */
    errorKey: error,
    success,
    setSuccess: (value: string) => {
      if (current()) setSuccess(value);
    },
    run,
  };
}
