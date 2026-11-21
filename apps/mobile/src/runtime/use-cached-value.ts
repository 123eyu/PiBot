import type { Events } from "@pibot/protocol";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { fileErrorKey } from "../features/files/errors.ts";
import type { MobileKey } from "../i18n/messages.ts";
import { cachedRead } from "../storage/cached-read.ts";
import { useLinkState, useRuntime } from "./context.tsx";

type EventName = keyof typeof Events;
/**
 * A read-only answer shown from the phone cache while offline and refreshed in place when the
 * link comes back (no blank flash): diffs, a run's changes, task details.
 */
export function useCachedValue<T extends z.ZodType>(
  key: string | undefined,
  schema: T,
  read: (signal: AbortSignal) => Promise<z.infer<T>>,
  events: readonly EventName[] = [],
) {
  const runtime = useRuntime(),
    mobile = useLinkState();
  const [value, setValue] = useState<z.infer<T>>();
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<MobileKey>();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const shown = useRef<string | undefined>(undefined);
  const hasValue = useRef(false);
  const online = mobile.status === "online";
  // biome-ignore lint/correctness/useExhaustiveDependencies: key, device and connection own the value; read is recreated each render.
  useEffect(() => {
    const computerId = mobile.selectedId;
    if (!key || !computerId) return;
    if (shown.current !== key) {
      hasValue.current = false;
      setValue(undefined);
    }
    shown.current = key;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      setBusy(true);
      setError(undefined);
      // B11 (phone 2026-11-14): online, a long chat's last receipt and changes card appeared a
      // second after the thread and pushed it up a row. The stored copy is shown first, as
      // offline, and the computer's answer replaces it in place.
      if (online && !hasValue.current)
        await cachedRead(runtime.storage.files, { computerId, online: false, key, schema }, () =>
          Promise.reject(new Error("offline")),
        ).then(
          (copy) => {
            if (abort.signal.aborted || hasValue.current) return;
            hasValue.current = true;
            setValue(copy.value);
            setStale(true);
          },
          () => undefined, // Nothing stored yet: the live answer below is the first one.
        );
      try {
        const result = await cachedRead(
          runtime.storage.files,
          { computerId, online, key, schema },
          () => read(abort.signal),
        );
        if (abort.signal.aborted) return;
        hasValue.current = true;
        setValue(result.value);
        setStale(result.stale);
      } catch (cause) {
        // While the link is still coming up, "not cached" is not worth an error line yet.
        if (!abort.signal.aborted && !(mobile.status === "connecting" && !online))
          setError(fileErrorKey(cause));
      } finally {
        if (!abort.signal.aborted) setBusy(false);
      }
    };
    void load();
    const on = mobile.peer?.on as
      | ((event: EventName, listener: () => void) => () => void)
      | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 300);
    };
    const off = on ? events.map((event) => on(event, refresh)) : [];
    return () => {
      abort.abort();
      clearTimeout(timer);
      for (const fn of off) fn();
    };
  }, [key, mobile.selectedId, mobile.peer, online, attempt]);
  return { value, stale, error, busy, online, retry: () => setAttempt((n) => n + 1) };
}
