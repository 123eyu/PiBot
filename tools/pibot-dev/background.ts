import { statSync } from "node:fs";
import { join } from "node:path";
import type { TaskRecord } from "./state.ts";

/*
 * A turn can end while a check it started still runs in the background; Pi Bot then opens
 * one more run in the same topic when that command ends.
 * Nothing of the running app is read: the only signal is the task note that automatic run writes.
 * Reading the live pibot.db from another process crashed the background process (SIGBUS,
 * 2026-11-02), so a running app's data is only reachable through its RPC.
 */

const POLL_MS = 30_000;
/** A check longer than this is not what the Bot described; the workflow nudges instead. */
const WAIT_MS = 45 * 60_000;
/** The automatic run may append to the note in several writes; two quiet minutes end it. */
const SETTLE_MS = 2 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reply wordings that say the turn stopped while a background command was still running. */
const BACKGROUND = /后台|background/i;
const AFTER_IT =
  /完成后|跑完|结束后|等它|when it (?:finishes|completes|ends|is done)|once it (?:finishes|completes|ends)|after it (?:finishes|completes|ends)/i;

export function waitsForBackground(reply: string) {
  return BACKGROUND.test(reply) && AFTER_IT.test(reply);
}

const notePath = (task: TaskRecord) =>
  join(task.worktree, "docs", "progress-notes", `${task.task}.md`);

/** Modification time of the task note, 0 when it does not exist yet. */
function noteMtime(task: TaskRecord) {
  try {
    return statSync(notePath(task)).mtimeMs;
  } catch {
    return 0;
  }
}

/** The note this turn had to write; one written before the turn started is stale. */
export function noteWrittenSince(task: TaskRecord, since: number) {
  return noteMtime(task) >= since;
}

export type BackgroundFollow =
  /** The turn finished its work (note written, or the reply does not wait for anything). */
  | "none"
  /** The automatic turn ran and updated the task note; nothing left to ask for. */
  | "note"
  /** Nothing came: one more turn in the topic has to collect the result and wrap up. */
  | "nudge";

/**
 * What to do after a turn that may have stopped before its background check: wait for the note the
 * automatic turn writes, or ask for one more turn when it never comes.
 */
export async function followBackgroundTurn(
  task: TaskRecord,
  turn: { text: string; startedAt: number },
): Promise<BackgroundFollow> {
  if (!waitsForBackground(turn.text)) return "none";
  if (noteWrittenSince(task, turn.startedAt)) return "none";
  const deadline = Date.now() + WAIT_MS;
  let seen = noteMtime(task);
  let settled = 0;
  for (;;) {
    const mtime = noteMtime(task);
    if (mtime > seen) {
      seen = mtime;
      settled = Date.now();
    }
    if (settled) {
      // Two quiet minutes mean the automatic turn is done writing; returning immediately would
      // read a half-written note in the briefing.
      if (Date.now() - settled >= SETTLE_MS) return "note";
    } else if (Date.now() >= deadline) {
      return "nudge";
    }
    await sleep(POLL_MS);
  }
}
