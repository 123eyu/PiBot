import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type RunnerJournalEntry,
  RunnerJournalEntrySchema,
  RunnerTargetIdSchema,
} from "@pibot/protocol-base";

export const RUNNER_IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const RUNNER_IDEMPOTENCY_MAX_ENTRIES = 10_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
export type JournalStatus = "started" | "done" | "unknown";
export type JournalEntry = RunnerJournalEntry;
export type JournalAdmission =
  | { status: "accepted"; persisted: Promise<void> }
  | { status: "existing" }
  | { status: "expired" }
  | { status: "busy" };

function expired(issuedAt: string, now = Date.now()) {
  const issued = Date.parse(issuedAt);
  return (
    !Number.isFinite(issued) ||
    issued > now + MAX_FUTURE_SKEW_MS ||
    now - issued > RUNNER_IDEMPOTENCY_RETENTION_MS
  );
}

/** One metadata-only journal file per target; command arguments, paths and output never enter it. */
export async function createExecutionJournal(directory: string, targetId: string) {
  RunnerTargetIdSchema.parse(targetId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const deviceId = targetId.slice("runner:".length);
  const path = join(directory, `executions-${deviceId}.jsonl`);
  let latest = new Map<string, JournalEntry>();
  let rewriteOnOpen = false;
  try {
    const text = await readFile(path, "utf8");
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line) continue;
      try {
        const item = RunnerJournalEntrySchema.parse(JSON.parse(line));
        if (item.targetId !== targetId) throw new Error("Runner journal target identity mismatch");
        latest.set(item.idempotencyKey, item);
      } catch (error) {
        // Only a torn final append is recoverable. Identity mismatch is never a torn write.
        if (error instanceof Error && error.message === "Runner journal target identity mismatch")
          throw error;
        if (index !== lines.length - 1 || text.endsWith("\n")) throw error;
      }
    }
    for (const [key, item] of latest) {
      if (expired(item.issuedAt)) {
        latest.delete(key);
        rewriteOnOpen = true;
      }
    }
    if (latest.size > RUNNER_IDEMPOTENCY_MAX_ENTRIES)
      throw new Error("Runner idempotency registry exceeds capacity");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  async function replace(entries: Map<string, JournalEntry>) {
    const temporary = `${path}.next`;
    const body = [...entries.values()].map((item) => JSON.stringify(item)).join("\n");
    await writeFile(temporary, body ? `${body}\n` : "", { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  }
  if (rewriteOnOpen) await replace(latest);

  const reservations = new Map<string, JournalEntry>();
  let chain = Promise.resolve();
  let failure: unknown;
  let compactionRequired = false;
  function pruneExpired(now = Date.now()) {
    let changed = false;
    for (const [key, item] of latest) {
      if (expired(item.issuedAt, now)) {
        latest.delete(key);
        changed = true;
      }
    }
    if (changed) compactionRequired = true;
  }
  async function append(entry: JournalEntry) {
    const candidate = new Map(latest);
    candidate.set(entry.idempotencyKey, entry);
    if (compactionRequired) {
      // The only entries omitted by this rewrite are beyond the seven-day retention window.
      await replace(candidate);
      compactionRequired = false;
    } else {
      await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    }
    latest = candidate;
  }
  function enqueue(entry: JournalEntry) {
    reservations.set(entry.idempotencyKey, entry);
    const work = chain.then(async () => {
      if (failure) throw failure;
      try {
        await append(entry);
        reservations.delete(entry.idempotencyKey);
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    chain = work.catch(() => {});
    return work;
  }
  function current(key: string) {
    return reservations.get(key) ?? latest.get(key);
  }
  function admission(key: string, issuedAt: string): JournalAdmission {
    if (failure) throw failure;
    const now = Date.now();
    pruneExpired(now);
    if (expired(issuedAt, now)) return { status: "expired" };
    const existing = current(key);
    if (existing)
      return existing.issuedAt === issuedAt ? { status: "existing" } : { status: "expired" };
    if (new Set([...latest.keys(), ...reservations.keys()]).size >= RUNNER_IDEMPOTENCY_MAX_ENTRIES)
      return { status: "busy" };
    const entry: JournalEntry = {
      idempotencyKey: key,
      issuedAt,
      status: "started",
      updatedAt: new Date(now).toISOString(),
      targetId,
    };
    return { status: "accepted", persisted: enqueue(entry) };
  }
  function update(key: string, status: "done" | "unknown", errorCode?: string) {
    if (failure) return Promise.reject(failure);
    const held = current(key);
    if (!held) return Promise.reject(new Error("Runner journal entry unavailable"));
    return enqueue({
      ...held,
      status,
      updatedAt: new Date().toISOString(),
      ...(errorCode ? { errorCode } : {}),
    });
  }
  for (const entry of [...latest.values()]) {
    if (entry.status === "started") await update(entry.idempotencyKey, "unknown");
  }
  return {
    targetId,
    path,
    admit: admission,
    inspect(key: string, issuedAt: string) {
      if (failure) throw failure;
      pruneExpired();
      if (expired(issuedAt)) return { status: "expired" as const };
      const item = current(key);
      if (!item) return { status: "missing" as const };
      if (item.issuedAt !== issuedAt) return { status: "expired" as const };
      return { status: item.status, item };
    },
    done(key: string) {
      return update(key, "done");
    },
    unknown(key: string, errorCode?: string) {
      return update(key, "unknown", errorCode);
    },
    async dispose() {
      await chain;
      if (failure) throw failure;
      if (compactionRequired) {
        await replace(latest);
        compactionRequired = false;
      }
    },
  };
}
export type ExecutionJournal = Awaited<ReturnType<typeof createExecutionJournal>>;
