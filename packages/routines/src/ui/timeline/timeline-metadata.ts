import type { Bot, Routine } from "@pibot/protocol";
import { type Peer, waitRpc } from "@pibot/renderer-kit";

export type TimelineBot = Pick<Bot, "id" | "name" | "avatarColor" | "archivedAt">;
export type TimelineRoutine = Pick<Routine, "id" | "name" | "deletedAt">;

export async function readTimelineBots(peer: Peer, ids: readonly string[], signal: AbortSignal) {
  const missing = new Set(ids);
  const result = new Map<string, TimelineBot | null>();
  let before: string | undefined;
  // No get-by-id endpoint exists. Bound the archived catalog walk, retaining only visible identities.
  for (let page = 0; missing.size && page < 20; page++) {
    const bots = await waitRpc(
      () => peer.call("bots.list", { includeArchived: true, before, limit: 200 }),
      signal,
    );
    signal.throwIfAborted();
    for (const bot of bots) {
      if (!missing.delete(bot.id)) continue;
      const { id, name, avatarColor, archivedAt } = bot;
      result.set(id, { id, name, avatarColor, archivedAt });
    }
    const next = bots.at(-1)?.id;
    if (bots.length < 200 || !next || next === before) break;
    before = next;
  }
  for (const id of missing) result.set(id, null);
  return result;
}

export async function readTimelineRoutines(
  peer: Peer,
  ids: readonly string[],
  signal: AbortSignal,
) {
  const unique = [...new Set(ids)];
  const result = new Map<string, TimelineRoutine | null>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < unique.length && !signal.aborted) {
      const id = unique[cursor++];
      if (!id) break;
      try {
        const routine = await waitRpc(() => peer.call("routines.get", { id }), signal);
        signal.throwIfAborted();
        if (routine.id !== id) throw new Error("Timeline task identity changed");
        const { name, deletedAt } = routine;
        result.set(id, { id, name, deletedAt });
      } catch {
        // Metadata is optional: a deleted/unavailable identity cannot hide execution facts.
        result.set(id, null);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, worker));
  for (const id of unique) if (!result.has(id)) result.set(id, null);
  return result;
}
