import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type PersonalTodo, PersonalTodoSchema } from "@pibot/protocol-base";
import { inboxOrigin } from "./inbox-origin.ts";

const columns =
  "id,title,color,sticker,end_at AS endAt,due_at AS dueAt,status,source_bot_id AS sourceBotId,source_conversation_id AS sourceConversationId,created_at AS createdAt,updated_at AS updatedAt";
export class PersonalTodosRepo {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string): PersonalTodo | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM personal_todos WHERE id=?`).get(id);
    return row ? PersonalTodoSchema.parse(row) : undefined;
  }
  create(
    input: Pick<
      PersonalTodo,
      "title" | "dueAt" | "sourceBotId" | "sourceConversationId" | "color" | "sticker" | "endAt"
    >,
    requestKey: string,
  ): PersonalTodo {
    const time = new Date().toISOString();
    const todo = PersonalTodoSchema.parse({
      ...input,
      id: randomUUID(),
      status: "open",
      createdAt: time,
      updatedAt: time,
    });
    this.db
      .prepare(
        "INSERT INTO personal_todos (id,title,due_at,status,source_bot_id,source_conversation_id,request_key,created_at,updated_at,color,sticker,end_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING",
      )
      .run(
        todo.id,
        todo.title,
        todo.dueAt,
        todo.status,
        todo.sourceBotId,
        todo.sourceConversationId,
        requestKey,
        time,
        time,
        todo.color ?? null,
        todo.sticker ?? null,
        todo.endAt ?? null,
      );
    const row = this.db
      .prepare(`SELECT ${columns} FROM personal_todos WHERE request_key=?`)
      .get(requestKey);
    return PersonalTodoSchema.parse(row);
  }
  list({
    status = "open",
    before,
    limit = 30,
    from,
    to,
  }: {
    status?: PersonalTodo["status"];
    before?: string;
    limit?: number;
    from?: string;
    to?: string;
  } = {}) {
    const cursor = before ? this.get(before) : undefined;
    if (before && (!cursor || cursor.status !== status)) return [];
    const lower = from ? " AND COALESCE(end_at,substr(due_at,1,10))>=?" : "";
    const upper = to ? " AND substr(due_at,1,10)<=?" : "";
    return this.db
      .prepare(
        `SELECT ${columns} FROM personal_todos WHERE status=?${lower}${upper} AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .all(
        status,
        ...(from ? [from] : []),
        ...(to ? [to] : []),
        before ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        before ?? null,
        limit,
      )
      .map((row) => PersonalTodoSchema.parse(row));
  }
  dueThrough(date: string): PersonalTodo[] {
    return this.db
      .prepare(
        `SELECT ${columns} FROM personal_todos
       WHERE status='open' AND COALESCE(end_at,substr(due_at,1,10))<=?
       ORDER BY COALESCE(end_at,substr(due_at,1,10)) DESC,created_at DESC,id DESC LIMIT 5`,
      )
      .all(date)
      .map((row) => PersonalTodoSchema.parse(row));
  }
  /** Totals for the Open / Completed filter chips; one grouped scan over the status index. */
  counts(): { open: number; done: number } {
    const totals = { open: 0, done: 0 };
    for (const row of this.db
      .prepare("SELECT status, count(*) AS total FROM personal_todos GROUP BY status")
      .all())
      if (row.status === "open" || row.status === "done") totals[row.status] = Number(row.total);
    return totals;
  }
  undatedCount(): number {
    return Number(
      this.db
        .prepare(
          "SELECT count(*) AS total FROM personal_todos WHERE status='open' AND due_at IS NULL",
        )
        .get()?.total ?? 0,
    );
  }
  /** UI projection only: model tools keep the original personal-todo result. */
  listWithOrigin(input: Parameters<PersonalTodosRepo["list"]>[0] = {}) {
    return this.list(input).map((todo) => ({
      ...todo,
      origin: inboxOrigin(this.db, { todo }, null),
    }));
  }
  update(
    id: string,
    input: Pick<PersonalTodo, "title" | "dueAt" | "color" | "sticker" | "endAt">,
  ): PersonalTodo {
    const old = this.get(id);
    if (!old) throw new TypeError("personal_todo_unavailable");
    const next = PersonalTodoSchema.parse({
      ...old,
      ...input,
      endAt:
        input.endAt === undefined
          ? old.endAt && input.dueAt && old.endAt >= input.dueAt.slice(0, 10)
            ? old.endAt
            : null
          : input.endAt,
    });
    this.db
      .prepare(
        "UPDATE personal_todos SET title=?,due_at=?,color=?,sticker=?,end_at=?,updated_at=? WHERE id=?",
      )
      .run(
        next.title,
        next.dueAt,
        next.color ?? null,
        next.sticker ?? null,
        next.endAt ?? null,
        new Date().toISOString(),
        id,
      );
    return this.get(id) as PersonalTodo;
  }
  remove(id: string) {
    this.db.prepare("DELETE FROM personal_todos WHERE id=?").run(id);
  }
  setStatus(id: string, status: PersonalTodo["status"]): PersonalTodo {
    if (!this.get(id)) throw new TypeError("personal_todo_unavailable");
    this.db
      .prepare("UPDATE personal_todos SET status=?,updated_at=? WHERE id=? AND status<>?")
      .run(status, new Date().toISOString(), id, status);
    return this.get(id) as PersonalTodo;
  }
}
