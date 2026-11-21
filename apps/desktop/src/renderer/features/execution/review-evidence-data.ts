import type { Peer } from "@pibot/renderer-kit";
import { useEffect, useRef, useState } from "react";

/** Metadata pages never validate evidence; only an explicitly opened record performs that read. */
export function useEvidencePages<T extends { id: string }>(
  peer: Peer | null,
  key: string,
  enabled: boolean,
  revision: number,
  read: (
    before: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ items: T[]; next: string | null }>,
) {
  const reader = useRef(read);
  reader.current = read;
  const lifetime = useRef<AbortController | undefined>(undefined);
  const locked = useRef(false);
  const [state, setState] = useState<{
    peer: Peer;
    key: string;
    revision: number;
    items: T[];
    next: string | null;
    busy: boolean;
    error: boolean;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    locked.current = false;
    if (!peer || !enabled) return () => controller.abort();
    locked.current = true;
    setState({ peer, key, revision, items: [], next: null, busy: true, error: false });
    void reader
      .current(undefined, controller.signal)
      .then(
        (page) => {
          if (!controller.signal.aborted)
            setState({ peer, key, revision, ...page, busy: false, error: false });
        },
        () => {
          if (!controller.signal.aborted)
            setState({ peer, key, revision, items: [], next: null, busy: false, error: true });
        },
      )
      .finally(() => {
        if (lifetime.current === controller) locked.current = false;
      });
    return () => controller.abort();
  }, [peer, key, enabled, revision]);
  const current =
    enabled && state?.peer === peer && state.key === key && state.revision === revision
      ? state
      : undefined;
  const more = async () => {
    const controller = lifetime.current,
      before = current?.next;
    if (!peer || !enabled || !controller || controller.signal.aborted || !before || locked.current)
      return;
    locked.current = true;
    setState((old) => old && { ...old, busy: true, error: false });
    try {
      const page = await reader.current(before, controller.signal);
      if (page.next === before) throw new Error("Evidence cursor did not advance");
      if (!controller.signal.aborted)
        setState((old) => {
          if (old?.peer !== peer || old.key !== key || old.revision !== revision) return old;
          const ids = new Set(old.items.map((item) => item.id));
          return {
            ...old,
            items: [...old.items, ...page.items.filter((item) => !ids.has(item.id))].slice(0, 200),
            next: page.next,
            busy: false,
            error: false,
          };
        });
    } catch {
      if (!controller.signal.aborted)
        setState((old) => old && { ...old, busy: false, error: true });
    } finally {
      if (lifetime.current === controller) locked.current = false;
    }
  };
  return {
    items: current?.items ?? [],
    next: current?.next,
    busy: enabled && !!peer && (!current || current.busy),
    error: enabled && (!peer || (current?.error ?? false)),
    more,
  };
}

/** Peer, scope, and revision participate in the visible result identity before effects run. */
export function useEvidenceRecord<T>(
  peer: Peer | null,
  key: string,
  revision: number,
  read: (signal: AbortSignal) => Promise<T>,
) {
  const reader = useRef(read);
  reader.current = read;
  const [state, setState] = useState<{
    peer: Peer;
    key: string;
    revision: number;
    value?: T;
    error: boolean;
  }>();
  useEffect(() => {
    if (!peer) return;
    const controller = new AbortController();
    void reader.current(controller.signal).then(
      (value) => {
        if (!controller.signal.aborted) setState({ peer, key, revision, value, error: false });
      },
      () => {
        if (!controller.signal.aborted) setState({ peer, key, revision, error: true });
      },
    );
    return () => controller.abort();
  }, [peer, key, revision]);
  const current =
    state?.peer === peer && state.key === key && state.revision === revision ? state : undefined;
  return {
    value: current?.value,
    error: !peer || (current?.error ?? false),
    busy: !!peer && !current,
  };
}
