import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { actorStep, actorWindow, finite } from "./retro-facts.ts";
import type { RetroEvent, RetroFailure, RetroSummary } from "./retro-types.ts";
import type { TaskRecord } from "./state.ts";

const policy = new Set(["policy_denied", "policy_blocked", "approval_denied", "permission_denied"]);
const sandbox = new Set([
  "sandbox_denied",
  "sandbox_unavailable",
  "sandbox_failed",
  "sandbox_violation",
]);
const tool = new Set([
  "command_failed",
  "file_failed",
  "timeout",
  "tool_failed",
  "execution_failed",
]);
const identity = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9:_-]{1,128}$/.test(value) ? value : undefined;
function failure(value: unknown): RetroFailure {
  return typeof value === "string" && policy.has(value)
    ? "policy"
    : typeof value === "string" && sandbox.has(value)
      ? "sandbox"
      : typeof value === "string" && tool.has(value)
        ? "tool"
        : "other";
}
/** Only fixed event metadata survives parsing; arbitrary error text/tool output is discarded. */
export function parseRetroEvent(value: unknown): RetroEvent | undefined {
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  const event =
    row.event === "model_request"
      ? "model_request"
      : row.event === "model_reconnect" && row.phase === "start"
        ? "model_reconnect"
        : row.module === "tool" && row.event === "result"
          ? "tool_result"
          : row.event === "run_end" || row.event === "run_completed"
            ? "run_end"
            : undefined;
  if (!event) return;
  for (const key of [
    "runId",
    "sessionId",
    "taskId",
    "botId",
    "groupId",
    "cycleId",
    "topicId",
    "conversationId",
    "budgetRootRunId",
  ])
    if (row[key] != null && !identity(row[key])) return;
  return {
    event,
    runId: identity(row.runId),
    sessionId: identity(row.sessionId),
    taskId: identity(row.taskId),
    botId: identity(row.botId),
    groupId: identity(row.groupId),
    cycleId: identity(row.cycleId),
    topicId: identity(row.topicId),
    conversationId: identity(row.conversationId),
    budgetRootRunId: identity(row.budgetRootRunId),
    ...(finite(row.durationMs) ? { durationMs: row.durationMs } : {}),
    ...(event === "tool_result"
      ? { failed: !!row.errorCode, ...(row.errorCode ? { failure: failure(row.errorCode) } : {}) }
      : {}),
  };
}
export function readRetroEvents(
  task: TaskRecord,
  dataDir?: string,
  signal?: AbortSignal,
): {
  events: RetroEvent[];
  logSource: RetroSummary["logSource"];
} {
  if (!dataDir) return { events: [], logSource: { status: "unknown", reason: "not_configured" } };
  if (!isAbsolute(dataDir)) throw new Error("retro_data_directory_invalid");
  let root: string;
  try {
    root = realpathSync(dataDir);
  } catch {
    return { events: [], logSource: { status: "unknown", reason: "missing_logs" } };
  }
  const days = new Set<string>();
  const actors = task.steps.filter((step) => actorStep(step.step));
  let windowKnown = actors.length > 0;
  for (const step of actors) {
    const { to, from, complete } = actorWindow(step);
    if (!complete) windowKnown = false;
    if (!Number.isFinite(to)) continue;
    for (let at = Math.floor(from / 86400000) * 86400000; at <= to; at += 86400000) {
      if (days.size >= 32)
        return { events: [], logSource: { status: "unknown", reason: "bounded_or_unreadable" } };
      days.add(new Date(at).toISOString().slice(0, 10));
    }
  }
  const events: RetroEvent[] = [];
  let bytes = 0,
    found = 0,
    partial = !windowKnown;
  for (const day of days) {
    signal?.throwIfAborted();
    const file = join(root, "logs", `${day}.log`);
    let text: string;
    try {
      const info = lstatSync(file);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size > 8 * 1024 * 1024 ||
        bytes + info.size > 16 * 1024 * 1024 ||
        realpathSync(file) !== resolve(file)
      ) {
        partial = true;
        continue;
      }
      bytes += info.size;
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd);
        if (opened.dev !== info.dev || opened.ino !== info.ino || opened.nlink !== 1)
          throw new Error("retro_log_changed");
        const buffer = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < buffer.length) {
          signal?.throwIfAborted();
          const count = readSync(
            fd,
            buffer,
            offset,
            Math.min(65536, buffer.length - offset),
            offset,
          );
          if (!count) throw new Error("retro_log_changed");
          offset += count;
        }
        if (fstatSync(fd).size !== info.size) partial = true;
        text = buffer.toString("utf8");
      } finally {
        closeSync(fd);
      }
      found++;
    } catch {
      // Missing/inaccessible logs provide no zero-valued evidence and never reveal native errors.
      partial = true;
      continue;
    }
    for (const line of text.split("\n")) {
      signal?.throwIfAborted();
      if (!line.trim()) continue;
      if (line.length > 128 * 1024 || events.length >= 100000) {
        partial = true;
        continue;
      }
      let row: unknown;
      try {
        const outer = JSON.parse(line);
        row = typeof outer.message === "string" ? JSON.parse(outer.message) : outer;
      } catch {
        partial = true;
        continue;
      }
      const event = parseRetroEvent(row);
      if (event) events.push(event);
    }
  }
  return {
    events,
    logSource: {
      status: !found ? "unknown" : partial ? "partial" : "available",
      reason: !found
        ? "missing_logs"
        : !windowKnown
          ? "incomplete_window"
          : partial
            ? "bounded_or_unreadable"
            : "explicit_logs",
    },
  };
}
