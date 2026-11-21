import { Methods } from "@pibot/protocol";
import { IdSchema, PersonalTodoSchema } from "@pibot/protocol-base";
import { z } from "zod";

/**
 * Maintainers 2026-11-20: the phone keeps its own copy of the personal to-dos so the tab works with
 * the computer offline, and the edits made meanwhile wait in a queue that is replayed in order on
 * reconnect. Both sit under `cache:<computer>:`, so unpairing deletes them with the other copies;
 * neither holds a key or token.
 */
export const todoKeys = {
  copy: (computerId: string) => `cache:${computerId}:todos`,
  edits: (computerId: string) => `cache:${computerId}:todo-edits`,
};
export const TODO_PAGE = 100;
/** Open to-dos are read whole (undated ones have no range to ask for), up to this many pages. */
export const TODO_OPEN_PAGES = 5;
/** Months whose completed to-dos are kept; the least recently viewed goes first. */
export const TODO_DONE_MONTHS = 6;
export const TODO_EDITS = 200;
const ROWS = TODO_OPEN_PAGES * TODO_PAGE;

export const TodoRowSchema = Methods["personalTodos.list"].result.element;
export type TodoRow = z.infer<typeof TodoRowSchema>;
const MonthSchema = z.string().regex(/^\d{4}-\d{2}$/);
export const StoredTodosSchema = z.object({
  open: z.array(TodoRowSchema).max(ROWS),
  /** False when there were more open to-dos than the phone reads. */
  openComplete: z.boolean(),
  undated: z.number().int().nonnegative(),
  done: z
    .array(
      z.object({
        month: MonthSchema,
        rows: z.array(TodoRowSchema).max(ROWS),
      }),
    )
    .max(TODO_DONE_MONTHS),
  syncedAt: z.iso.datetime().optional(),
});
export type StoredTodos = z.infer<typeof StoredTodosSchema>;
export const emptyTodos: StoredTodos = { open: [], openComplete: true, undated: 0, done: [] };

export const TodoFieldsSchema = z.strictObject({
  title: PersonalTodoSchema.shape.title,
  dueAt: PersonalTodoSchema.shape.dueAt,
  color: PersonalTodoSchema.shape.color,
  sticker: PersonalTodoSchema.shape.sticker,
  endAt: PersonalTodoSchema.shape.endAt,
});
export type TodoFields = z.infer<typeof TodoFieldsSchema>;
const at = z.iso.datetime();
/** `base`: the row's `updatedAt` as the phone last knew it (the computer's clock). */
const base = z.iso.datetime().optional();
export const TodoEditSchema = z.discriminatedUnion("kind", [
  // `id` is the phone's temporary id until the computer answers with its own.
  z.strictObject({
    kind: z.literal("create"),
    id: IdSchema,
    requestId: IdSchema,
    at,
    fields: TodoFieldsSchema,
  }),
  z.strictObject({ kind: z.literal("update"), id: IdSchema, at, base, fields: TodoFieldsSchema }),
  z.strictObject({
    kind: z.literal("status"),
    id: IdSchema,
    at,
    base,
    status: z.enum(["open", "done"]),
  }),
  z.strictObject({ kind: z.literal("delete"), id: IdSchema, at, base }),
]);
export type TodoEdit = z.infer<typeof TodoEditSchema>;
export const StoredEditsSchema = z.object({
  edits: z.array(TodoEditSchema).max(TODO_EDITS),
  /** Temporary id → the computer's id, so a sheet still open on a replayed create edits the row. */
  created: z.array(z.tuple([IdSchema, IdSchema])).max(50),
});
export type StoredEdits = z.infer<typeof StoredEditsSchema>;
export const emptyEdits: StoredEdits = { edits: [], created: [] };

const later = (a: string | undefined, b: string | undefined) =>
  !a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b;
/**
 * The "changed after" time sent with a replayed edit. The later of the edit's own time and the
 * version it was made on: a row the computer has not touched since passes even when the phone's
 * clock runs behind, and one changed on the computer after the edit keeps that change.
 */
export const guardTime = (edit: Exclude<TodoEdit, { kind: "create" }>) =>
  later(edit.at, edit.base) ?? edit.at;

export function resolveId(state: StoredEdits, id: string) {
  return state.created.find(([local]) => local === id)?.[1] ?? id;
}
/**
 * Adds one edit. Changes to a to-do that is itself still waiting to be created fold into that
 * create (or, for a delete, drop it), so the computer never sees the in-between versions. A
 * create already on its way (`sending`) is left as it is; the edit then follows it in line.
 */
export function addEdit(state: StoredEdits, edit: TodoEdit, sending?: TodoEdit): StoredEdits {
  const id = resolveId(state, edit.id);
  const next = { ...edit, id } as TodoEdit;
  const found = state.edits.find((item) => item.kind === "create" && item.id === id);
  const pending = found === sending ? undefined : found;
  if (pending?.kind === "create" && next.kind === "update")
    return {
      ...state,
      edits: state.edits.map((item) =>
        item === pending ? { ...pending, fields: next.fields } : item,
      ),
    };
  if (pending && next.kind === "delete")
    return { ...state, edits: state.edits.filter((item) => item.id !== id) };
  if (state.edits.length >= TODO_EDITS) throw new Error("todo_queue_full");
  return { ...state, edits: [...state.edits, next] };
}
/**
 * After the computer took the first edit: later edits of the same to-do carry its id and the
 * version it answered with, so they are not mistaken for a newer change made elsewhere.
 */
export function settleFirst(state: StoredEdits, result?: { localId?: string; row?: TodoRow }) {
  const [first, ...rest] = state.edits;
  if (!first) return state;
  const row = result?.row;
  const local = result?.localId;
  const from = local ?? first.id;
  const edits = rest.map((edit) =>
    row && edit.id === from && edit.kind !== "create"
      ? { ...edit, id: row.id, base: later(edit.base, row.updatedAt) }
      : edit,
  );
  const created: StoredEdits["created"] =
    local && row
      ? [...state.created, [local, row.id] as [string, string]].slice(-50)
      : state.created;
  return { edits, created };
}

function applyFields(row: TodoRow, fields: TodoFields, time: string): TodoRow {
  return { ...row, ...fields, updatedAt: time };
}
/**
 * What the tab shows: the stored copy with the waiting edits applied in order, and which to-dos
 * still have an edit the computer has not taken ("Not synced yet").
 */
export function withEdits(rows: readonly TodoRow[], edits: readonly TodoEdit[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const pending = new Set<string>();
  for (const edit of edits) {
    pending.add(edit.id);
    const row = byId.get(edit.id);
    if (edit.kind === "create")
      byId.set(edit.id, {
        ...edit.fields,
        id: edit.id,
        status: "open",
        sourceBotId: null,
        sourceConversationId: null,
        createdAt: edit.at,
        updatedAt: edit.at,
      });
    else if (edit.kind === "delete") byId.delete(edit.id);
    else if (row && edit.kind === "update")
      byId.set(edit.id, applyFields(row, edit.fields, edit.at));
    else if (row && edit.kind === "status")
      byId.set(edit.id, { ...row, status: edit.status, updatedAt: edit.at });
  }
  return { rows: [...byId.values()], pending };
}
/** Every stored row once; a row in several slices keeps its newest version. */
export function storedRows(copy: StoredTodos) {
  const byId = new Map<string, TodoRow>();
  for (const row of [...copy.open, ...copy.done.flatMap((slice) => slice.rows)]) {
    const known = byId.get(row.id);
    if (!known || Date.parse(row.updatedAt) > Date.parse(known.updatedAt)) byId.set(row.id, row);
  }
  return [...byId.values()];
}
/** The newest month first; a re-read month moves to the front. */
export function withDoneMonth(copy: StoredTodos, month: string, rows: TodoRow[]): StoredTodos {
  return {
    ...copy,
    done: [{ month, rows }, ...copy.done.filter((slice) => slice.month !== month)].slice(
      0,
      TODO_DONE_MONTHS,
    ),
  };
}
/**
 * The computer's answer to a replayed edit, written into the copy at once: the edit leaves the
 * queue in the same step, and the row must not flash back to its old version until the next read.
 */
export function withAnswer(
  copy: StoredTodos,
  answer: { id: string; localId?: string; row?: TodoRow },
): StoredTodos {
  const gone = new Set([answer.id, answer.localId, answer.row?.id]);
  const keep = (rows: TodoRow[]) => rows.filter((row) => !gone.has(row.id));
  const row = answer.row;
  const open = keep(copy.open);
  const done = copy.done.map((slice) => ({ ...slice, rows: keep(slice.rows) }));
  if (row?.status === "open") open.unshift(row);
  if (row?.status === "done") {
    const month = row.dueAt?.slice(0, 7);
    const slice = done.find((item) => item.month === month) ?? done[0];
    if (slice) slice.rows = [row, ...slice.rows].slice(0, ROWS);
    else if (month) done.push({ month, rows: [row] });
  }
  // The caps keep the copy readable: a value over them would read back as no copy at all.
  return { ...copy, open: open.slice(0, ROWS), done };
}
