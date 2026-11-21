import { z } from "zod";
import type { AcpGroupRunReceipt, AcpTarget } from "./types.ts";

/*
 * Sessions this brain created over ACP, kept so a later connection can continue one with
 * session/load (the self-iteration workflow reconnects for every step). Only ACP-created
 * sessions are recorded, so load can never attach a client to a person's ordinary topic. The
 * topics themselves live in Pi Bot's database; with a persistence port the session → topic map
 * survives an app restart too (maintainers 2026-11-04: keep a task in one topic so it does not rebuild
 * its context — installs restart the app mid-task). It holds ids and folder paths, no content.
 */
export interface AcpSessionRecord {
  id: string;
  botId: string;
  target?: AcpTarget;
  groupRun?: AcpGroupRunReceipt;
  roots: string[];
  /** Bot id → topic id, as setMode created them. */
  topics: [string, string][];
  /** Topics this session creates start in YOLO (client asked on session/new). */
  yolo: boolean;
  /**
   * The session was attached to an existing topic the person owns, not one it created. Such a
   * topic is never archived by session/delete, and the session never applies YOLO to it.
   */
  attached?: boolean;
}
export interface AcpSessionMemory {
  remember(record: AcpSessionRecord): void;
  recall(id: string): AcpSessionRecord | undefined;
  /**
   * One live connection per session: two tools loading the same topic would push
   * two tasks into it and move its folder under each other. False when another holds it.
   */
  claim(id: string): boolean;
  release(id: string): void;
  /** Drops a record (session/delete); a later session/load of it falls back to a new session. */
  forget(id: string): void;
}
/** Where records outlive the brain; injected by the host (the acp package does no file I/O). */
export interface AcpSessionPersistence {
  load(): unknown;
  save(value: unknown): void;
}

const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const id = z.string().min(1).max(200);
const StoredSchema = z.object({
  version: z.literal(1),
  records: z
    .array(
      z.object({
        id,
        botId: id,
        groupRun: z
          .object({
            groupId: id,
            topicId: id,
            runId: id,
            assistantMessageId: id,
            cycleId: id,
            budgetRootRunId: id,
            runIds: z.array(id).min(1).max(512),
          })
          .optional(),
        target: z
          .discriminatedUnion("kind", [
            z.object({ kind: z.literal("bot"), botId: id }),
            z.object({ kind: z.literal("group"), groupId: id }),
          ])
          .optional(),
        roots: z.array(z.string().min(1).max(4096)).min(1).max(21),
        topics: z.array(z.tuple([id, id])).max(64),
        yolo: z.boolean(),
        // Absent in older records; those sessions created their own topics.
        attached: z.boolean().optional(),
        savedAt: z.number(),
      }),
    )
    .max(256),
});

const copy = (record: AcpSessionRecord): AcpSessionRecord => {
  if (
    record.groupRun &&
    (record.target?.kind !== "group" ||
      record.target.groupId !== record.groupRun.groupId ||
      !record.topics.some(
        ([key, topic]) =>
          key === `group:${record.groupRun?.groupId}` && topic === record.groupRun?.topicId,
      ))
  )
    throw new Error("ACP session group receipt does not match its target");
  return {
    id: record.id,
    botId: record.botId,
    ...(record.target ? { target: { ...record.target } } : {}),
    ...(record.groupRun
      ? { groupRun: { ...record.groupRun, runIds: [...record.groupRun.runIds] } }
      : {}),
    roots: [...record.roots],
    topics: record.topics.map(([bot, topic]) => [bot, topic]),
    yolo: record.yolo,
    ...(record.attached ? { attached: true } : {}),
  };
};

export function createAcpSessionMemory(
  options: { limit?: number; persistence?: AcpSessionPersistence; now?: () => number } = {},
): AcpSessionMemory {
  const limit = options.limit ?? 64;
  const now = options.now ?? Date.now;
  const records = new Map<string, { record: AcpSessionRecord; savedAt: number }>();
  const open = new Set<string>();
  if (options.persistence) {
    // A damaged or foreign file only costs continuity: the client falls back to a new session.
    const stored = StoredSchema.safeParse(options.persistence.load());
    if (stored.success)
      for (const { savedAt, ...record } of stored.data.records) {
        if (now() - savedAt >= MAX_AGE_MS) continue;
        try {
          records.set(record.id, { record: copy(record), savedAt });
        } catch {
          /* A mismatched persisted target/receipt cannot authorize a group recovery. */
        }
      }
  }
  const save = () =>
    options.persistence?.save({
      version: 1,
      records: [...records.values()].map(({ record, savedAt }) => ({ ...record, savedAt })),
    });
  return {
    remember(record) {
      const safe = copy(record);
      records.delete(record.id);
      records.set(record.id, { record: safe, savedAt: now() });
      while (records.size > limit) records.delete(records.keys().next().value as string);
      save();
    },
    claim(id) {
      if (open.has(id)) return false;
      open.add(id);
      return true;
    },
    release(id) {
      open.delete(id);
    },
    forget(id) {
      if (records.delete(id)) save();
    },
    recall(id) {
      const entry = records.get(id);
      if (!entry || now() - entry.savedAt >= MAX_AGE_MS) return undefined;
      return copy(entry.record);
    },
  };
}
