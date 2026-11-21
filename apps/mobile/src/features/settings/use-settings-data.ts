import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { useLinkState, useRuntime } from "../../runtime/context.tsx";
import { useAction } from "../../runtime/use-action.ts";
import {
  settingsCachedAt,
  settingsCacheKey,
  writeSettingsCache,
} from "../../storage/settings-cache.ts";
import type { MobilePeer } from "../../transport/session.ts";
import { settingsConflict } from "./calls.ts";

interface Options<T> {
  /** Scope of the page, e.g. `bot:<id>`; also names the offline copy. */
  key: string;
  read(signal: AbortSignal): Promise<T>;
  schema: z.ZodType<T>;
  /** Change events that make the page re-read; each returns its unsubscribe function. */
  subscribe(peer: MobilePeer, refresh: () => void): (() => void)[];
}
/**
 * One settings page's data. The computer owns the settings: the page re-reads on the
 * same change events the desktop listens to, and keeps only the last value it read so it can be
 * shown read-only while the computer is offline. Writes refetch afterwards; a write that lost to
 * a newer change on the computer shows the "changed on the computer" notice instead of an error.
 */
export function useSettingsData<T>({ key, read, schema, subscribe }: Options<T>) {
  const runtime = useRuntime(),
    mobile = useLinkState();
  const [data, setData] = useState<T>();
  const [cached, setCached] = useState(false);
  const [cachedAt, setCachedAt] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const scope = `${mobile.selectedId}:settings:${key}`;
  const reader = useAction(scope, mobile.peer);
  const write = useAction(scope, mobile.peer);
  const online = mobile.status === "online";
  const computerId = mobile.selectedId;
  const readRef = useRef(read);
  readRef.current = read;
  const dataRef = useRef(data);
  dataRef.current = data;
  const shownScope = useRef<string>(undefined);
  // The copy may come from this page or from the background catalog sync (features/sync).
  const stored = async () => {
    if (!computerId) return undefined;
    const value = schema.safeParse(
      await runtime.storage.data.get(settingsCacheKey(computerId, key)),
    );
    if (!value.success) return undefined;
    return { value: value.data, at: await settingsCachedAt(runtime.storage.data, computerId, key) };
  };
  const load = () =>
    reader.read(async (signal) => {
      if (!computerId) return;
      if (mobile.status !== "online") {
        const copy = await stored();
        signal.throwIfAborted();
        // A missing or outdated copy just leaves the page empty until the computer is back.
        if (copy) {
          setData(copy.value);
          setCachedAt(copy.at);
        }
        setCached(true);
        return;
      }
      // Opening the page shows the last copy at once (read-only) while the computer answers,
      // instead of a blank page.
      if (dataRef.current === undefined) {
        const copy = await stored();
        signal.throwIfAborted();
        if (copy && dataRef.current === undefined) {
          setData(copy.value);
          setCachedAt(copy.at);
          setCached(true);
        }
      }
      const next = await readRef.current(signal);
      signal.throwIfAborted();
      setData(next);
      setCached(false);
      setCachedAt(undefined);
      await writeSettingsCache(runtime.storage.data, computerId, key, schema.parse(next));
    });
  // biome-ignore lint/correctness/useExhaustiveDependencies: the page scope and connection own the data; read/subscribe are recreated each render.
  useEffect(() => {
    // Only another Bot / group clears the page; a reconnect keeps showing what it had.
    if (shownScope.current !== scope) {
      shownScope.current = scope;
      setData(undefined);
      dataRef.current = undefined;
    }
    setConflict(false);
    void load();
    const peer = mobile.peer;
    if (!peer) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 300);
    };
    const off = subscribe(peer, refresh);
    return () => {
      clearTimeout(timer);
      for (const fn of off) fn();
    };
  }, [scope, mobile.peer, mobile.refreshVersion]);
  /** Resolves to the operation's value, or undefined when it failed, conflicted or was busy. */
  const apply = <R>(operation: (signal: AbortSignal) => Promise<R>, onConflict?: () => void) =>
    write.run(async (signal) => {
      setConflict(false);
      try {
        const result = await operation(signal);
        void load();
        return result;
      } catch (error) {
        if (!settingsConflict(error)) throw error;
        setConflict(true);
        onConflict?.();
        void load();
        return undefined;
      }
    });
  return {
    data,
    online,
    /** Writes are allowed only against live values from the computer. */
    editable: online && !cached && !!data && !write.busy,
    cached,
    /** When a shown copy was read from the computer (absent for live values and old copies). */
    cachedAt: cached ? cachedAt : undefined,
    connectionState:
      mobile.status === "connecting" || mobile.reconnecting
        ? ("settingsConnecting" as const)
        : !online
          ? // A stored copy is shown read-only with its own notice (SettingsPage).
            data === undefined
            ? ("settingsEmptyOffline" as const)
            : undefined
          : !reader.error && (reader.busy || cached || !data)
            ? ("settingsUpdating" as const)
            : undefined,
    conflict,
    busy: write.busy,
    error: write.error ?? reader.error,
    load,
    apply,
  };
}
