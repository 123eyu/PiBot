import type { DatabaseSync } from "node:sqlite";
import {
  IdSchema,
  type RoutineQueryInput,
  RoutineQueryInputSchema,
  RoutineSchema,
} from "@pibot/protocol";
import { readPage } from "@pibot/storage";
import { RoutineTriggersRepo } from "../definitions/triggers.ts";

const metadata = RoutineSchema.pick({
  id: true,
  name: true,
  instructions: true,
  version: true,
  enabled: true,
  createdAt: true,
});

export class RoutineQueryRepo {
  constructor(private readonly db: DatabaseSync) {}
  page(botId: string, input: RoutineQueryInput) {
    const { name, before, limit } = RoutineQueryInputSchema.parse(input);
    const scope: [string, string | null][] = [["bot_id", IdSchema.parse(botId)]];
    if (name) scope.push(["name", name]);
    const filters = [...scope, ["deleted_at", null] as [string, null]];
    const rows = readPage(
      this.db,
      "routines",
      "id,name,instructions,version,enabled,created_at AS createdAt",
      "created_at",
      { before, limit: limit + 1 },
      filters,
      scope,
    );
    const total = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM routines WHERE bot_id=? AND deleted_at IS NULL${name ? " AND name=?" : ""}`,
      )
      .get(botId, ...(name ? [name] : []));
    const triggers = new RoutineTriggersRepo(this.db);
    return {
      // Keep complete strings until brain has masked secrets, then generate bounded previews.
      routines: rows.slice(0, limit).map((row) => {
        const value = metadata.parse({ ...row, enabled: row.enabled === 1 });
        const configs = triggers.list(value.id, { limit: 5 }).map((t) => t.config);
        return { ...value, triggers: configs.slice(0, 4), moreTriggers: configs.length > 4 };
      }),
      nextBefore: rows.length > limit ? String(rows[limit - 1]?.id) : null,
      totalMatches: Number(total?.n ?? 0),
      selectionRequired: !!name && Number(total?.n) > 1,
    };
  }
}
