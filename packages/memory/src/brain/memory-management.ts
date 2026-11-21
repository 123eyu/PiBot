import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { BrainRedactor, RegisterRpc } from "@pibot/brain/kit";
import {
  type KernelEvents,
  type KernelMethodParams,
  type KernelMethodResults,
  type KernelMethods,
  type MemoryOwner,
  type Peer,
  RpcError,
} from "@pibot/protocol-base";
import {
  MemoriesRepo,
  MemoryManagementRepo,
  MemoryProjectsRepo,
  MemoryUndoRepo,
  memoryStatus,
} from "@pibot/storage";
import { applyManagedMemory } from "./memory-management-write.ts";
import { undoableMemory } from "./memory-reversal.ts";
import type { MemoryService } from "./memory-service.ts";

/** Explicit user management is distinct from model tools and their runtime policy decisions. */
export function registerMemoryManagement(
  handle: RegisterRpc,
  db: DatabaseSync,
  peer: Peer<typeof KernelMethods, typeof KernelEvents>,
  redactor: BrainRedactor,
  memory: MemoryService,
) {
  const register = handle as <K extends keyof typeof KernelMethods>(
    method: K,
    action: (
      params: KernelMethodParams[K],
      context: { signal: AbortSignal },
    ) => Promise<KernelMethodResults[K]>,
  ) => void;
  const metadata = new MemoryManagementRepo(db);
  const repoFor = (owner: MemoryOwner) => new MemoriesRepo(db, (s) => redactor.redact(s), owner);
  const actorFor = (owner: MemoryOwner) => {
    try {
      return metadata.actor(owner);
    } catch (error) {
      if (error instanceof TypeError && error.message === "memory_owner_unavailable")
        throw new RpcError(-32602, "memory_owner_unavailable");
      throw error;
    }
  };
  register("memory.catalog", async ({ after }, { signal }) => {
    signal.throwIfAborted();
    return metadata.catalog(after).map((o) => ({ ...o, name: redactor.redact(o.name) }));
  });
  register("memory.project", async ({ path }, { signal }) => {
    signal.throwIfAborted();
    if (!isAbsolute(path)) return { projectId: null };
    // Projects are keyed by the canonical folder the run resolved, so match it the same way.
    const canonical = await realpath(path).catch(() => undefined);
    return {
      projectId: canonical ? (new MemoryProjectsRepo(db).byPath(canonical)?.id ?? null) : null,
    };
  });
  register("memory.summary", async (owner, { signal }) => {
    signal.throwIfAborted();
    actorFor(owner);
    return memoryStatus(db, owner);
  });
  register(
    "memory.browse",
    async (
      { scope, ownerId, before, proposalsBefore, undoBefore, expectedRevision, state },
      { signal },
    ) => {
      signal.throwIfAborted();
      const owner = { scope, ownerId };
      const actor = actorFor(owner);
      const revision = metadata.revision(owner);
      if (expectedRevision !== undefined && expectedRevision !== revision)
        throw new RpcError(-32011, "memory_conflict");
      const candidates = metadata.undoCandidates(owner, undoBefore);
      const byBot = new Map<string, Set<string>>();
      for (const candidate of candidates) {
        const ids = byBot.get(candidate.botId) ?? new Set<string>();
        ids.add(candidate.id);
        byBot.set(candidate.botId, ids);
      }
      // The existing service owns snapshot identity and semantic conflict checks.
      const undoable = [...byBot]
        .flatMap(([botId, ids]) =>
          undoableMemory(db, botId, repoFor(owner), new MemoryUndoRepo(db), redactor, [...ids]),
        )
        .sort((a, b) => b.id.localeCompare(a.id));
      const items = repoFor(owner).page(actor, { before, limit: 50 }, state);
      return {
        presentation: metadata.presentation(items.map((m) => m.id)).map((item) => ({
          ...item,
          botName: item.botName === null ? null : redactor.redact(item.botName),
        })),
        undoable,
        undoNext: candidates.length === 50 ? (candidates.at(-1)?.id ?? null) : null,
        items,
        proposals: repoFor(owner).proposals(actor, { before: proposalsBefore, limit: 50 }),
        revision,
        ...memoryStatus(db, owner),
      };
    },
  );
  register("memory.details", async ({ scope, ownerId, id, before }, { signal }) => {
    signal.throwIfAborted();
    const owner = { scope, ownerId };
    const actor = actorFor(owner);
    const target = repoFor(owner).get(actor, id);
    if (!target) throw new RpcError(-32602, "memory_unavailable");
    const details = metadata.details(target.id, before);
    return {
      sources: details.sources.map((s) => ({
        ...s,
        botName: redactor.redact(s.botName),
        conversationTitle:
          s.conversationTitle === null ? null : redactor.redact(s.conversationTitle),
      })),
      history: details.history.map((r) => ({ ...r, text: redactor.redact(r.text) })),
    };
  });
  register("memory.manage", async ({ scope, ownerId, change }, context) => {
    context.signal.throwIfAborted();
    memory.flushUsage();
    const owner = { scope, ownerId };
    const actor = actorFor(owner);
    return applyManagedMemory(db, peer, redactor, owner, actor, change, context.signal);
  });
}
