import type { Events } from "@pibot/protocol";
import { useEffect, useState } from "react";
import { useLinkState } from "../../../runtime/context.tsx";
import { useAction } from "../../../runtime/use-action.ts";

type EventName = keyof typeof Events;
/**
 * A value read from the computer for one chat scope, re-read when the scope, connection or one of
 * the given events changes. Writes use a separate action so a background re-read never blocks them.
 */
export function useRemoteValue<T>(
  key: string | undefined,
  read: (signal: AbortSignal) => Promise<T>,
  events: readonly EventName[] = [],
) {
  const mobile = useLinkState();
  const [value, setValue] = useState<T>();
  const action = useAction(`${mobile.selectedId}:${key}`, mobile.peer);
  const write = useAction(`${mobile.selectedId}:${key}`, mobile.peer);
  const load = () =>
    action.read(async (signal) => {
      if (!key || mobile.status !== "online") return;
      const next = await read(signal);
      signal.throwIfAborted();
      setValue(next);
    });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the scope key and connection own the value; read is recreated each render.
  useEffect(() => {
    setValue(undefined);
    void load();
    const peer = mobile.peer;
    if (!peer || !key) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 300);
    };
    // Events only trigger a re-read here, so their payload types do not matter.
    const on = peer.on as (event: EventName, listener: () => void) => () => void;
    const off = events.map((event) => on(event, refresh));
    return () => {
      clearTimeout(timer);
      for (const fn of off) fn();
    };
  }, [mobile.selectedId, mobile.peer, key, mobile.refreshVersion]);
  return { value, setValue, action, write, load, online: mobile.status === "online" };
}
