import { useCallback, useSyncExternalStore } from "react";
import type { DraftComment } from "./comments.ts";

/**
 * Unsent comments per conversation, in memory only: closing the sidebar or switching files keeps
 * them until they are sent or cleared; quitting the app drops them (they may quote code).
 */
const drafts = new Map<string, readonly DraftComment[]>();
const listeners = new Set<() => void>();
const none: readonly DraftComment[] = [];
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useDraftComments(key: string) {
  const snapshot = () => drafts.get(key) ?? none;
  const comments = useSyncExternalStore(subscribe, snapshot, snapshot);
  const update = useCallback(
    (change: (current: readonly DraftComment[]) => readonly DraftComment[]) => {
      const next = change(drafts.get(key) ?? none);
      if (next.length) drafts.set(key, next);
      else drafts.delete(key);
      for (const listener of listeners) listener();
    },
    [key],
  );
  return [comments, update] as const;
}
