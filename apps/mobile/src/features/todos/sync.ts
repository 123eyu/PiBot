import { dayKey, monthDays } from "@pibot/client-core";
import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { MobileRuntime } from "../../runtime/runtime.ts";
import {
  guardTime,
  type StoredTodos,
  TODO_OPEN_PAGES,
  TODO_PAGE,
  type TodoEdit,
  type TodoRow,
  withDoneMonth,
} from "./model.ts";

type Caller = Pick<MobileRuntime, "call">;
const READ_MS = 15_000;

async function pages(
  c: Caller,
  params: { status: "open" | "done"; from?: string; to?: string },
  signal: AbortSignal,
) {
  const rows: TodoRow[] = [];
  let before: string | undefined;
  for (let page = 0; page < TODO_OPEN_PAGES; page++) {
    signal.throwIfAborted();
    const next = await c.call(
      "personalTodos.list",
      { ...params, before, limit: TODO_PAGE },
      signal,
      READ_MS,
    );
    rows.push(...next);
    if (next.length < TODO_PAGE) return { rows, complete: true };
    const last = next.at(-1)?.id;
    if (!last || last === before) throw new Error("personal_todo_cursor_stalled");
    before = last;
  }
  return { rows, complete: false };
}
/** The days a month's page shows, including the neighbouring days of its first and last week. */
export function monthRange(month: string) {
  const days = monthDays(month);
  return { from: dayKey(days[0] as Date), to: dayKey(days.at(-1) as Date) };
}
/** Completed to-dos only for the month on screen: they have no end, open ones are read whole. */
export async function readDoneMonth(
  c: Caller,
  copy: StoredTodos,
  month: string,
  signal: AbortSignal,
) {
  const done = await pages(c, { status: "done", ...monthRange(month) }, signal);
  return withDoneMonth(copy, month, done.rows);
}
/** A full refresh: every open to-do (dated or not), the month's completed ones and the count. */
export async function readTodos(c: Caller, copy: StoredTodos, month: string, signal: AbortSignal) {
  const open = await pages(c, { status: "open" }, signal);
  const undated = await c.call("personalTodos.undatedCount", undefined, signal, READ_MS);
  const next: StoredTodos = {
    ...copy,
    open: open.rows,
    openComplete: open.complete,
    undated,
    syncedAt: new Date().toISOString(),
  };
  return readDoneMonth(c, next, month, signal);
}

export type ReplayOutcome =
  | { kind: "applied"; row?: TodoRow; localId?: string }
  | { kind: "dropped"; reason: "changed" | "gone" | "refused" };
/**
 * Only a refusal about this edit drops it; a lost link, a timeout or a busy computer stops the
 * replay with the edit still first in line (a timed-out write is safe to send again: a create
 * carries its request id and a guarded edit that already landed is then simply refused).
 */
function dropReason(error: unknown) {
  if (!(error instanceof RpcError) || error.code !== RpcErrorCodes.invalidParams) return undefined;
  if (error.message === "personal_todo_changed") return "changed" as const;
  if (error.message === "personal_todo_unavailable") return "gone" as const;
  return "refused" as const;
}
export async function replayEdit(
  c: Caller,
  edit: TodoEdit,
  signal: AbortSignal,
): Promise<ReplayOutcome> {
  try {
    if (edit.kind === "create") {
      const row = await c.call(
        "personalTodos.create",
        { requestId: edit.requestId, ...edit.fields },
        signal,
      );
      return { kind: "applied", row, localId: edit.id };
    }
    const unchangedSince = guardTime(edit);
    if (edit.kind === "update")
      return {
        kind: "applied",
        row: await c.call(
          "personalTodos.update",
          { id: edit.id, unchangedSince, ...edit.fields },
          signal,
        ),
      };
    if (edit.kind === "status")
      return {
        kind: "applied",
        row: await c.call(
          "personalTodos.setStatus",
          { id: edit.id, status: edit.status, unchangedSince },
          signal,
        ),
      };
    await c.call("personalTodos.delete", { id: edit.id, confirmed: true, unchangedSince }, signal);
    return { kind: "applied" };
  } catch (error) {
    const reason = dropReason(error);
    if (!reason || signal.aborted) throw error;
    return { kind: "dropped", reason };
  }
}
