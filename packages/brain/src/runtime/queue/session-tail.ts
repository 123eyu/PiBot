import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { readSessionRecovery, resolveSessionFile } from "@pibot/agent";
import type { Logger } from "@pibot/observability";
import { RunEventsRepo, type SessionTailCandidate } from "@pibot/storage";

type TailIdentity = {
  runId: string;
  botId: string;
  conversationId: string;
  sessionFile: string;
};

async function inspectTail(dataDir: string, value: TailIdentity, expectedEntryId?: string) {
  return readSessionRecovery({
    sessionDir: join(dataDir, "bots", value.botId, "sessions"),
    sessionFile: resolveSessionFile(dataDir, value.sessionFile),
    signal: AbortSignal.timeout(15_000),
    expectedEntryId,
  });
}

/** A drained SDK prompt has persisted JSONL; this event is the event/cache comparison waterline. */
export async function recordSessionTail(
  db: DatabaseSync,
  dataDir: string,
  logger: Logger,
  value: TailIdentity,
) {
  const events = new RunEventsRepo(db);
  const throughSeq = events.sessionFactSeq(value.sessionFile);
  try {
    const tail = await inspectTail(dataDir, value);
    events.append({
      runId: value.runId,
      conversationId: value.conversationId,
      kind: "session.synced",
      sessionEntryId: tail.tailEntryId,
      payload: { throughSeq },
    });
  } catch {
    events.append({
      runId: value.runId,
      conversationId: value.conversationId,
      kind: "session.interrupted",
      payload: { throughSeq, reason: "jsonl_unavailable_after_drain" },
    });
    logger.warn(
      JSON.stringify({ module: "session", event: "tail_unavailable", runId: value.runId }),
    );
  }
}

function appendReconciliation(
  events: RunEventsRepo,
  candidate: SessionTailCandidate,
  kind: "session.interrupted" | "session.backfilled",
  reason: string,
  sessionEntryId: string | null,
) {
  events.append({
    runId: candidate.runId,
    conversationId: candidate.conversationId,
    kind,
    sessionEntryId,
    payload: { throughSeq: candidate.factSeq, reason },
  });
}

/** Snapshot before projection recovery changes running/waiting status or appends facts. */
export function snapshotSessionTails(
  events: RunEventsRepo,
  signal: AbortSignal,
  progress?: () => void,
) {
  const startedAt = performance.now();
  let candidates = 0;
  const dirty: SessionTailCandidate[] = [];
  let legacyAfter = "",
    legacyCount = 0;
  for (;;) {
    signal.throwIfAborted();
    progress?.();
    const page = events.backfillLegacyLifecycle(legacyAfter, 200);
    legacyCount += page.count;
    if (page.count < 200) break;
    legacyAfter = page.last;
  }
  const legacyMs = Math.round(performance.now() - startedAt);
  const scanStartedAt = performance.now();
  let after = "";
  for (;;) {
    signal.throwIfAborted();
    progress?.();
    const page = events.sessionTailCandidates(after, 100);
    candidates += page.length;
    for (const candidate of page) {
      signal.throwIfAborted();
      const marker = candidate.marker;
      // Startup must stay fast with hundreds of sessions: only a run that was still running or a
      // session with facts after its last watermark can have a crash gap. Cleanly finished
      // sessions are settled from SQLite alone; unwatermarked legacy runs are covered by the
      // lifecycle backfill above.
      const crashed = ["running", "waiting"].includes(candidate.runStatus);
      const ahead = !!marker && candidate.factSeq > marker.throughSeq;
      // Only `!ahead` used to be enough for a settled session, but the watermark never
      // covered the terminal event, so every cleanly finished session looked ahead and its whole
      // JSONL was re-read at each startup. Terminal events are now out of the watermark. A run still
      // `running`/`waiting` is never skipped: the SDK can have appended JSONL that no event recorded,
      // and the database facts cannot show that.
      if (crashed || ahead) dirty.push(candidate);
    }
    if (page.length < 100) break;
    after = page.at(-1)?.file ?? after;
  }
  return {
    startedAt,
    dirty,
    legacyCount,
    candidates,
    legacyMs,
    candidateScanMs: Math.round(performance.now() - scanStartedAt),
  };
}

export async function reconcileSessionTails(
  events: RunEventsRepo,
  dataDir: string,
  logger: Logger,
  signal: AbortSignal,
  snapshot: ReturnType<typeof snapshotSessionTails>,
) {
  // The caller can publish ready before any JSONL I/O. Requests opening SDK sessions
  // wait for this exact snapshot to finish; the classification cannot drift with live writes.
  await yieldTurn(undefined, { signal });
  let inspected = 0,
    unavailable = 0;
  for (const candidate of snapshot.dirty) {
    signal.throwIfAborted();
    const marker = candidate.marker;
    inspected++;
    const tailStartedAt = performance.now();
    let outcome: "reconciled" | "unavailable" | "cancelled" = "cancelled";
    try {
      const tail = await readSessionRecovery({
        sessionDir: join(dataDir, "bots", candidate.botId, "sessions"),
        sessionFile: resolveSessionFile(dataDir, candidate.file),
        signal,
        expectedEntryId: marker?.sessionEntryId ?? undefined,
      });
      const current = tail.tailEntryId;
      if (!marker) {
        const crashedInteractive =
          candidate.runKind !== "routine" && ["running", "waiting"].includes(candidate.runStatus);
        appendReconciliation(
          events,
          candidate,
          current && !crashedInteractive ? "session.backfilled" : "session.interrupted",
          crashedInteractive
            ? "unwatermarked_run_at_startup"
            : current
              ? "untracked_jsonl_tail"
              : "event_without_jsonl_tail",
          current,
        );
      } else if (marker.sessionEntryId === current) {
        if (candidate.factSeq > marker.throughSeq)
          appendReconciliation(
            events,
            candidate,
            "session.interrupted",
            "event_ahead_of_jsonl",
            current,
          );
      } else if (
        (marker.sessionEntryId === null && current !== null) ||
        tail.expectedEntryOnBranch === true
      ) {
        appendReconciliation(
          events,
          candidate,
          candidate.factSeq > marker.throughSeq ? "session.interrupted" : "session.backfilled",
          candidate.factSeq > marker.throughSeq
            ? "event_and_jsonl_advanced"
            : "jsonl_ahead_of_event",
          current,
        );
      } else if (marker.kind !== "session.interrupted" || marker.throughSeq < candidate.factSeq) {
        appendReconciliation(
          events,
          candidate,
          "session.interrupted",
          "jsonl_tail_diverged",
          current,
        );
      }
      outcome = "reconciled";
    } catch {
      signal.throwIfAborted();
      unavailable++;
      outcome = "unavailable";
      if (
        marker?.kind !== "session.interrupted" ||
        marker.throughSeq < candidate.factSeq ||
        marker.sessionEntryId !== null
      )
        appendReconciliation(
          events,
          candidate,
          "session.interrupted",
          "jsonl_unavailable_at_startup",
          null,
        );
    } finally {
      // Ordinal and run identity locate a slow tail without logging its path or JSONL content.
      logger.info(
        JSON.stringify({
          module: "session",
          event: "tail_reconciliation_candidate",
          runId: candidate.runId,
          ordinal: inspected,
          elapsedMs: Math.round(performance.now() - tailStartedAt),
          outcome,
        }),
      );
    }
  }
  logger.info(
    JSON.stringify({
      module: "session",
      event: "tail_reconciliation_complete",
      legacyRuns: snapshot.legacyCount,
      candidates: snapshot.candidates,
      inspected,
      skipped: snapshot.candidates - inspected,
      unavailable,
      legacyMs: snapshot.legacyMs,
      candidateScanMs: snapshot.candidateScanMs,
      elapsedMs: Math.round(performance.now() - snapshot.startedAt),
    }),
  );
}
