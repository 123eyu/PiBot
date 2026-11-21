import type { PublicRun } from "../data.ts";

type Identity = {
  runId: string | null;
  botId?: string;
  conversationId?: string;
  messageId?: string;
  threadId?: string;
};
type Terminal = Identity & { status?: "done" | "error" | "aborted" };
const live = (run: PublicRun) => run.status === "queued" || run.status === "running";
const matches = (run: PublicRun, event: Identity) =>
  run.id === event.runId &&
  run.botId === event.botId &&
  run.conversationId === event.conversationId &&
  (!event.messageId || run.messageId === event.messageId) &&
  (!event.threadId || event.threadId === run.conversationId);

/** Late status/read responses must not resurrect an exact identity after its terminal event. */
export class GroupRunState {
  private terminals = new Map<string, Terminal>();
  clear() {
    this.terminals.clear();
  }
  terminal(runs: PublicRun[], event: Identity, status?: Terminal["status"]) {
    if (!event.runId || !event.botId || !event.conversationId) return runs;
    const known = runs.find((run) => run.id === event.runId);
    if (known && !matches(known, event)) return runs;
    const previous = this.terminals.get(event.runId);
    if (
      previous &&
      (previous.botId !== event.botId || previous.conversationId !== event.conversationId)
    )
      return runs;
    if (previous?.status) return runs;
    this.terminals.set(event.runId, { ...event, status: previous?.status ?? status });
    if (this.terminals.size > 1000)
      this.terminals.delete(this.terminals.keys().next().value as string);
    return this.reconcile(runs);
  }
  progress(runs: PublicRun[], event: Identity, status: "queued" | "running") {
    if (event.runId && this.terminals.has(event.runId)) return runs;
    if (!runs.some((run) => matches(run, event) && live(run) && run.status !== status)) return runs;
    return runs.map((run) =>
      matches(run, event) && live(run) && run.status !== status ? { ...run, status } : run,
    );
  }
  reconcile(runs: PublicRun[], current: PublicRun[] = [], partial = false) {
    const previous = new Map(current.map((run) => [run.id, run]));
    const covered = new Set(runs.map((run) => run.id));
    // Only a complete, unchanged scan can disprove an already-known active identity.
    const retained = partial ? current.filter((run) => live(run) && !covered.has(run.id)) : [];
    return [...runs, ...retained].flatMap((run) => {
      const ended = this.terminals.get(run.id);
      if (ended && matches(run, ended)) {
        if (ended.status && live(run)) return [{ ...run, status: ended.status }];
        // Idle does not invent done; a subsequent authoritative row retains its actual result.
        if (!ended.status && live(run)) return [];
      }
      const old = previous.get(run.id);
      return [
        old &&
        !live(old) &&
        live(run) &&
        old.botId === run.botId &&
        old.conversationId === run.conversationId &&
        old.messageId === run.messageId
          ? old
          : run,
      ];
    });
  }
}
