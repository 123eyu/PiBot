import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  IdSchema,
  type Page,
  PageSchema,
  type RoutinePreauthInput,
  RoutinePreauthInputSchema,
  RoutinePreauthSchema,
  type WorkspaceSnapshot,
  WorkspaceSnapshotSchema,
} from "@pibot/protocol";
import { readPage, transaction } from "@pibot/storage";
import { z } from "zod";

// Program order and duplicates do not change a consent's scope.
export function routinePreauthKey(operation: RoutinePreauthInput) {
  return JSON.stringify(
    operation.scope.kind === "programs"
      ? {
          ...operation,
          scope: { ...operation.scope, programs: [...new Set(operation.scope.programs)].sort() },
        }
      : operation,
  );
}
const columns =
  "id,routine_id AS routineId,category,scope,workspace_snapshot AS workspaceSnapshot,created_at AS createdAt,revoked_at AS revokedAt";
function isPreauthShapeError(error: unknown) {
  return error instanceof SyntaxError || error instanceof z.ZodError;
}
function parse(row: Record<string, unknown>) {
  const { category, scope, workspaceSnapshot, ...rest } = row;
  return RoutinePreauthSchema.parse({
    ...rest,
    operation: { category, scope: JSON.parse(String(scope)) },
    workspaceSnapshot: workspaceSnapshot == null ? null : JSON.parse(String(workspaceSnapshot)),
  });
}
export class RoutinePreauthRepo {
  constructor(private readonly db: DatabaseSync) {}
  require(id: string) {
    const value = this.get(id);
    if (!value) throw new TypeError("Missing persisted record");
    return value;
  }
  get(id: string) {
    const row = this.db
      .prepare(`SELECT ${columns} FROM routine_preauth WHERE id=?`)
      .get(IdSchema.parse(id));
    return row ? parse(row) : undefined;
  }
  list(scope: { routineId?: string; botId?: string } = {}, page: Page = {}) {
    const filters: [string, string | null][] = [["revoked_at", null]];
    if (scope.routineId) filters.push(["routine_id", IdSchema.parse(scope.routineId)]);
    if (scope.botId) return this.forBot(IdSchema.parse(scope.botId), scope.routineId, page);
    return readPage(
      this.db,
      "routine_preauth",
      columns,
      "created_at",
      page,
      filters,
      scope.routineId ? [["routine_id", scope.routineId]] : [],
    ).map(parse);
  }
  /** Active pre-authorizations of several routines in one indexed query (at most 200 each). */
  forRoutines(routineIds: readonly string[], invalid = new Set<string>()) {
    const byRoutine = new Map<string, ReturnType<typeof parse>[]>();
    if (!routineIds.length) return byRoutine;
    const rows = this.db
      .prepare(
        `SELECT ${columns} FROM routine_preauth WHERE routine_id IN (SELECT value FROM json_each(?)) AND revoked_at IS NULL ORDER BY created_at DESC,id DESC`,
      )
      .all(JSON.stringify(routineIds.map((id) => IdSchema.parse(id))));
    for (const row of rows) {
      let preauth: ReturnType<typeof parse>;
      try {
        preauth = parse(row);
      } catch (error) {
        if (!isPreauthShapeError(error)) throw error;
        invalid.add(IdSchema.parse(row.routineId));
        continue;
      }
      const list = byRoutine.get(preauth.routineId) ?? [];
      if (list.length >= 200) {
        invalid.add(preauth.routineId);
        continue;
      }
      list.push(preauth);
      byRoutine.set(preauth.routineId, list);
    }
    for (const id of invalid) byRoutine.delete(id);
    return byRoutine;
  }
  private forBot(botId: string, routineId: string | undefined, page: Page) {
    const parsed = PageSchema.parse(page),
      cursor = parsed.before ? this.get(parsed.before) : undefined;
    if (
      parsed.before &&
      (!cursor ||
        (routineId !== undefined && cursor.routineId !== routineId) ||
        !this.db
          .prepare("SELECT 1 FROM routines WHERE id=? AND bot_id=?")
          .get(cursor.routineId, botId))
    )
      return [];
    return this.db
      .prepare(
        `SELECT ${columns} FROM routine_preauth WHERE revoked_at IS NULL AND routine_id IN (SELECT id FROM routines WHERE bot_id=? AND deleted_at IS NULL) AND (? IS NULL OR routine_id=?) AND (? IS NULL OR created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .all(
        botId,
        routineId ?? null,
        routineId ?? null,
        parsed.before ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        parsed.before ?? null,
        parsed.limit ?? 50,
      )
      .map(parse);
  }
  add(routineId: string, input: RoutinePreauthInput, snapshot: WorkspaceSnapshot | null = null) {
    const operation = RoutinePreauthInputSchema.parse(input),
      ceiling = snapshot ? WorkspaceSnapshotSchema.parse(snapshot) : null;
    return transaction(this.db, () => {
      if (
        !this.db
          .prepare("SELECT 1 FROM routines WHERE id=? AND deleted_at IS NULL")
          .get(IdSchema.parse(routineId))
      )
        throw new TypeError("Unknown routine");
      const scope = JSON.stringify(operation.scope),
        existing = this.db
          .prepare(
            `SELECT ${columns} FROM routine_preauth WHERE routine_id=? AND category=? AND scope=? AND revoked_at IS NULL`,
          )
          .get(routineId, operation.category, scope);
      if (existing) return parse(existing);
      const count = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM routine_preauth WHERE routine_id=? AND revoked_at IS NULL",
        )
        .get(routineId);
      if (Number(count?.n ?? 0) >= 200) throw new TypeError("Too many preauthorizations");
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO routine_preauth(id,routine_id,category,scope,workspace_snapshot,created_at) VALUES (?,?,?,?,?,?)",
        )
        .run(
          id,
          routineId,
          operation.category,
          scope,
          ceiling ? JSON.stringify(ceiling) : null,
          new Date().toISOString(),
        );
      return this.require(id);
    });
  }
  replace(
    routineId: string,
    operations: RoutinePreauthInput[],
    snapshot: WorkspaceSnapshot | null = null,
  ) {
    if (operations.length > 200) throw new TypeError("Too many preauthorizations");
    const parsed = operations.map((operation) => RoutinePreauthInputSchema.parse(operation));
    transaction(this.db, () => {
      const invalid = new Set<string>();
      let existing = this.forRoutines([routineId], invalid).get(routineId) ?? [];
      if (invalid.has(routineId)) {
        // Broken consent cannot be retained by an ordinary edit; explicit replacement is revalidated.
        this.db
          .prepare(
            "UPDATE routine_preauth SET revoked_at=? WHERE routine_id=? AND revoked_at IS NULL",
          )
          .run(new Date().toISOString(), IdSchema.parse(routineId));
        existing = [];
      }
      const desired = new Map(parsed.map((operation) => [routinePreauthKey(operation), operation]));
      const retained = new Set<string>();
      const ceiling = snapshot === null ? null : WorkspaceSnapshotSchema.parse(snapshot);
      for (const record of existing) {
        const key = routinePreauthKey(record.operation);
        if (desired.has(key)) {
          // Editing another permission must not erase this scope's existing consent boundary.
          retained.add(key);
        } else this.revoke(record.id);
      }
      for (const [key, operation] of desired)
        if (!retained.has(key)) this.add(routineId, operation, ceiling);
    });
  }
  revoke(id: string) {
    return (
      this.db
        .prepare("UPDATE routine_preauth SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
        .run(new Date().toISOString(), IdSchema.parse(id)).changes > 0
    );
  }
}
