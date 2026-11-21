import type { MobileStorage } from "../../storage/state.ts";
import type { Caller } from "../chat/controls/scope.ts";
import type { Conversation } from "../conversations/model.ts";
import {
  auditRow,
  type ChatRun,
  chatRow,
  commandRow,
  compareRecords,
  RECORD_LIMITS,
  type RecordRow,
  type RecordSource,
  RecordSources,
  recordCutoff,
  recordKey,
  routineRow,
  type SourceCopy,
} from "./model.ts";

type Row<K extends RecordSource> = SourceCopy<K>["rows"][number];
const timeOf: { [K in RecordSource]: (row: Row<K>) => string } = {
  audit: (row) => row.at,
  routines: (row) => row.createdAt,
  chats: (row) => row.createdAt,
  commands: (row) => row.endedAt ?? row.startedAt,
};
const isActiveRun = (row: Row<"chats">) => ["queued", "running", "waiting"].includes(row.status);

/** The phone's copy of one source; an unreadable copy is just an empty one. */
export async function readSource<K extends RecordSource>(
  storage: MobileStorage,
  computerId: string,
  source: K,
): Promise<SourceCopy<K>> {
  const parsed = RecordSources[source].safeParse(
    await storage.data.get(recordKey(computerId, source)),
  );
  return parsed.success
    ? (parsed.data as SourceCopy<K>)
    : ({ rows: [], truncated: false, syncedAt: 0 } as unknown as SourceCopy<K>);
}
/**
 * Stores newest first, only the window (in-progress runs and running commands stay), at most
 * the per-source count and the per-value size; older rows are what gets dropped.
 */
export async function writeSource<K extends RecordSource>(
  storage: MobileStorage,
  computerId: string,
  source: K,
  rows: Row<K>[],
  truncated: boolean,
  now = Date.now(),
) {
  const cutoff = recordCutoff(now);
  const time = timeOf[source] as (row: Row<K>) => string;
  const keep = (row: Row<K>) =>
    Date.parse(time(row)) >= cutoff ||
    (source === "chats" && isActiveRun(row as Row<"chats">)) ||
    (source === "commands" && (row as Row<"commands">).status === "running");
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()]
    .filter(keep)
    .sort((a, b) => time(b).localeCompare(time(a)) || b.id.localeCompare(a.id));
  let kept = unique.slice(0, RECORD_LIMITS[source]);
  let cut = truncated || kept.length < unique.length;
  while (kept.length && JSON.stringify(kept).length > RECORD_LIMITS.valueChars) {
    kept = kept.slice(0, Math.floor(kept.length * 0.9));
    cut = true;
  }
  const copy = RecordSources[source].parse({ rows: kept, truncated: cut, syncedAt: now });
  await storage.data.put(recordKey(computerId, source), copy);
  return copy as SourceCopy<K>;
}
/** All cached rows of one computer, newest first, with the window applied again on read. */
export async function readRecords(storage: MobileStorage, computerId: string, now = Date.now()) {
  const [audit, routines, chats, commands] = await Promise.all([
    readSource(storage, computerId, "audit"),
    readSource(storage, computerId, "routines"),
    readSource(storage, computerId, "chats"),
    readSource(storage, computerId, "commands"),
  ]);
  const cutoff = recordCutoff(now);
  const rows: RecordRow[] = [
    ...audit.rows.map(auditRow),
    ...routines.rows.map(routineRow),
    ...chats.rows.map(chatRow),
    ...commands.rows.map(commandRow),
  ].filter(
    (row) =>
      Date.parse(row.at) >= cutoff ||
      (row.type === "chat" && isActiveRun(row.run)) ||
      (row.type === "command" && row.command.status === "running"),
  );
  return {
    rows: rows.sort(compareRecords),
    truncated: audit.truncated || routines.truncated || chats.truncated || commands.truncated,
    syncedAt: Math.max(audit.syncedAt, routines.syncedAt, chats.syncedAt, commands.syncedAt),
  };
}

/**
 * Audit facts newest first, until a row the phone already has: one page in the usual case.
 * When the cap is reached first, the copy is replaced instead of merged so it never has a gap.
 */
async function syncAudit(
  c: Caller,
  storage: MobileStorage,
  computerId: string,
  signal: AbortSignal,
) {
  const cached = await readSource(storage, computerId, "audit");
  const known = new Set(cached.rows.map((row) => row.id));
  const fresh: Row<"audit">[] = [];
  let before: string | undefined;
  for (let page = 0; page < RECORD_LIMITS.auditPages; page++) {
    const rows = await c.call(
      "audit.list",
      { limit: RECORD_LIMITS.auditPage, ...(before ? { before } : {}) },
      signal,
    );
    signal.throwIfAborted();
    fresh.push(...rows);
    // The computer drops rows outside the window, so a short page is the end of it.
    if (rows.length < RECORD_LIMITS.auditPage || rows.some((row) => known.has(row.id)))
      return writeSource(
        storage,
        computerId,
        "audit",
        [...fresh, ...cached.rows],
        cached.truncated,
      );
    const last = rows.at(-1)?.id;
    if (!last || last === before) break;
    before = last;
  }
  return writeSource(storage, computerId, "audit", fresh, true);
}
/** Routine runs change status in place, so the window's newest pages replace the copy. */
async function syncRoutines(
  c: Caller,
  storage: MobileStorage,
  computerId: string,
  signal: AbortSignal,
) {
  const from = new Date(recordCutoff()).toISOString();
  const rows: Row<"routines">[] = [];
  let before: string | undefined;
  for (let page = 0; page < 2; page++) {
    const batch = await c.call(
      "routines.history",
      { from, limit: RECORD_LIMITS.routinePage, ...(before ? { before } : {}) },
      signal,
    );
    signal.throwIfAborted();
    rows.push(...batch);
    if (batch.length < RECORD_LIMITS.routinePage) break;
    before = batch.at(-1)?.id;
  }
  return writeSource(
    storage,
    computerId,
    "routines",
    rows,
    rows.length >= RECORD_LIMITS.routinePage * 2,
  );
}
async function syncCommands(
  c: Caller,
  storage: MobileStorage,
  computerId: string,
  signal: AbortSignal,
) {
  const [running, ended] = await Promise.all([
    c.call(
      "backgroundCommands.page",
      { state: "running", limit: RECORD_LIMITS.commandPage },
      signal,
    ),
    c.call("backgroundCommands.page", { state: "ended", limit: RECORD_LIMITS.commandPage }, signal),
  ]);
  signal.throwIfAborted();
  return writeSource(
    storage,
    computerId,
    "commands",
    [...running, ...ended],
    ended.length >= RECORD_LIMITS.commandPage,
  );
}
/**
 * Conversation runs: chat.runs is scoped to one Bot or group, so it reads the most recent
 * conversations (all of them on a full pass, one after a reply finished) and replaces their
 * runs in the copy. Routine runs are listed by their own source.
 */
async function syncChats(
  c: Caller,
  storage: MobileStorage,
  computerId: string,
  conversations: readonly Pick<Conversation, "kind" | "id">[],
  full: boolean,
  signal: AbortSignal,
) {
  const cached = await readSource(storage, computerId, "chats");
  const fresh: ChatRun[] = [];
  for (const row of conversations.slice(0, RECORD_LIMITS.runSources)) {
    const runs = await c.call(
      "chat.runs",
      {
        ...(row.kind === "bot" ? { botId: row.id } : { groupId: row.id }),
        limit: RECORD_LIMITS.runPage,
      },
      signal,
    );
    signal.throwIfAborted();
    fresh.push(...runs.filter((run) => run.kind !== "routine"));
  }
  const replaced = (run: ChatRun) =>
    conversations.some((row) =>
      row.kind === "group" ? run.groupId === row.id : !run.groupId && run.botId === row.id,
    );
  const rest = full ? [] : cached.rows.filter((run) => !replaced(run));
  return writeSource(storage, computerId, "chats", [...fresh, ...rest], cached.truncated && !full);
}

export type RecordWork = {
  audit?: boolean;
  routines?: boolean;
  commands?: boolean;
  /** "all": every recent conversation; otherwise only these. */
  chats?: "all" | Pick<Conversation, "kind" | "id">[];
};
export const FULL_SYNC: RecordWork = { audit: true, routines: true, commands: true, chats: "all" };
/**
 * Refreshes the requested sources one request at a time (the background lane and the gateway's
 * in-flight cap). One failing source does not stop the others; the first error is rethrown at
 * the end so a pull-to-refresh can still say it failed.
 */
export async function syncRecords(
  c: Caller,
  storage: MobileStorage,
  computerId: string,
  conversations: readonly Conversation[],
  work: RecordWork,
  signal: AbortSignal,
) {
  let failure: unknown;
  const step = async (enabled: unknown, run: () => Promise<unknown>) => {
    if (!enabled) return;
    signal.throwIfAborted();
    try {
      await run();
    } catch (error) {
      if (signal.aborted) throw error;
      failure ??= error;
    }
  };
  await step(work.audit, () => syncAudit(c, storage, computerId, signal));
  await step(work.routines, () => syncRoutines(c, storage, computerId, signal));
  await step(work.commands, () => syncCommands(c, storage, computerId, signal));
  await step(work.chats, () =>
    syncChats(
      c,
      storage,
      computerId,
      work.chats === "all" ? conversations : (work.chats ?? []),
      work.chats === "all",
      signal,
    ),
  );
  if (failure) throw failure;
}
/** Two pending refreshes as one (events within the debounce window). */
export function mergeWork(a: RecordWork, b: RecordWork): RecordWork {
  const chats =
    a.chats === "all" || b.chats === "all"
      ? "all"
      : a.chats || b.chats
        ? [
            ...new Map(
              [...(a.chats ?? []), ...(b.chats ?? [])].map((row) => [`${row.kind}:${row.id}`, row]),
            ).values(),
          ]
        : undefined;
  return {
    audit: a.audit || b.audit,
    routines: a.routines || b.routines,
    commands: a.commands || b.commands,
    ...(chats ? { chats } : {}),
  };
}
