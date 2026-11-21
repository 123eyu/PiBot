import type { RunsRepo } from "@pibot/storage";

/** Project committed lifecycle facts, including routine parks and chat approval pauses. */
export function createActiveRunStatus(repo: RunsRepo, emit: (count: number) => void) {
  const changes = new Set([
    "chat.status",
    "chat.done",
    "chat.error",
    "inbox.changed",
    "routines.changed",
    "approval.requested",
    "approval.resolved",
  ]);
  let disposed = false;
  let scheduled = false;
  let previous: number | undefined;
  const refresh = () => {
    if (disposed) return;
    const count = repo.activeCount();
    if (count === previous) return;
    previous = count;
    emit(count);
  };
  return {
    refresh,
    changed(method: string) {
      if (disposed || scheduled || !changes.has(method)) return;
      scheduled = true;
      // Lifecycle publishers may still be inside a surrounding transaction. Read only once
      // synchronous work has committed (or rolled back), without polling or reading deltas.
      queueMicrotask(() => {
        scheduled = false;
        refresh();
      });
    },
    dispose() {
      disposed = true;
    },
  };
}
