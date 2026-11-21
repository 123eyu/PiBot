import type { DatabaseSync } from "node:sqlite";
import type { Memory, MemoryOwner } from "@pibot/protocol-base";
import { MEMORY_SEARCH_LIMIT, type MemoriesRepo, searchMemoryIds } from "@pibot/storage";

/**
 * Memory_read / memory_search live apart from the write service because they must never
 * pass through proposals or the write policy, and because the service file was over the size the
 * project keeps per module. Callers hand in the same owner list the prompt injected, so a read can
 * never widen what the run can see.
 */
export function createMemoryReads(deps: {
  repoFor(owner: MemoryOwner): MemoriesRepo;
  recordUsage(ids: string[]): void;
}) {
  return {
    read(
      botId: string,
      owners: readonly MemoryOwner[],
      id: string,
      scope?: Memory["scope"],
    ): Memory | undefined {
      for (const owner of owners) {
        if (scope && owner.scope !== scope) continue;
        const value = deps.repoFor(owner).get(botId, id);
        if (value) {
          deps.recordUsage([value.id]);
          return value;
        }
      }
      return undefined;
    },
    search(
      db: DatabaseSync,
      botId: string,
      owners: readonly MemoryOwner[],
      query: string,
      scope?: Memory["scope"],
      limit = MEMORY_SEARCH_LIMIT,
      signal?: AbortSignal,
    ): Memory[] {
      signal?.throwIfAborted();
      const visible = owners.filter((owner) => !scope || owner.scope === scope);
      const notes = searchMemoryIds(db, visible, query, limit, signal).flatMap((hit) => {
        const note = deps.repoFor(hit).get(botId, hit.id);
        return note ? [note] : [];
      });
      // Recalled ids feed the same usage counter as the prompt, so "recently used" stays truthful.
      deps.recordUsage(notes.map((note) => note.id));
      return notes;
    },
  };
}
