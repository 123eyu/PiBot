import type { PublicRun } from "../data.ts";

/** Other members being busy never changes the recipient of the user's group instruction. */
export function groupSendTarget({
  runs,
  groupId,
  conversationId,
  cycleId,
  coordinatorBotId,
  thread,
  explicit,
}: {
  runs: readonly PublicRun[];
  groupId: string;
  conversationId: string;
  cycleId?: string | null;
  coordinatorBotId?: string;
  thread: boolean;
  explicit: readonly string[];
}) {
  const active = runs.filter(
    (run) =>
      run.status === "running" && run.groupId === groupId && (!cycleId || run.cycleId === cycleId),
  );
  const candidates = thread
    ? active.filter((run) => run.conversationId === conversationId)
    : explicit.length > 1
      ? []
      : active.filter(
          (run) =>
            run.botId === (explicit[0] ?? coordinatorBotId) &&
            (explicit.length > 0 || run.conversationId === conversationId),
        );
  return {
    run: candidates.length === 1 ? candidates[0] : undefined,
    ambiguous: candidates.length > 1,
  };
}
