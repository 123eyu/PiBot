import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type BotPage, type Grant, GrantPageSchema, GrantSchema } from "@pibot/protocol-base";
import { readPage } from "../database/paging.ts";

const columns = `id, bot_id AS botId, group_id AS groupId, category, scope, created_at AS createdAt, revoked_at AS revokedAt`;
function parseGrant(row: Record<string, unknown>): Grant {
  const { groupId, ...fields } = row;
  return GrantSchema.parse({
    ...fields,
    ...(groupId ? { groupId } : {}),
    scope: JSON.parse(String(row.scope)),
  });
}

export class GrantsRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(input: Pick<Grant, "botId" | "category" | "scope" | "groupId">): Grant {
    const grant = GrantSchema.parse({
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      revokedAt: null,
    });
    if (grant.scope.kind === "programs") {
      grant.scope.programs = [...new Set(grant.scope.programs)].sort();
    }
    this.db
      .prepare(`INSERT INTO grants(id, bot_id, category, scope, created_at, revoked_at,group_id)
      VALUES (?, ?, ?, ?, ?, NULL,?)`)
      .run(
        grant.id,
        grant.botId,
        grant.category,
        JSON.stringify(grant.scope),
        grant.createdAt,
        grant.groupId ?? null,
      );
    return grant;
  }

  /**
   * The unrevoked connection-tool grant with exactly this scope for this Bot or group, so several
   * pending drafts that each tick "remember" share one grant instead of stacking duplicates.
   */
  activeConnectorTool(input: {
    botId: string;
    groupId?: string;
    connectorId: string;
    tool: string;
    definitionDigest: string;
  }): Grant | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM grants
      WHERE revoked_at IS NULL AND category='connector' AND bot_id=? AND group_id IS ?
        AND json_extract(scope,'$.kind')='connector_tool'
        AND json_extract(scope,'$.connectorId')=? AND json_extract(scope,'$.tool')=?
        AND json_extract(scope,'$.definitionDigest')=?
      ORDER BY created_at,id LIMIT 1`)
      .get(
        input.botId,
        input.groupId ?? null,
        input.connectorId,
        input.tool,
        input.definitionDigest,
      );
    return row ? parseGrant(row) : undefined;
  }

  get(id: string): Grant | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM grants WHERE id = ?`).get(id);
    return row ? parseGrant(row) : undefined;
  }

  list(query: BotPage & { groupId?: string; connectorId?: string } = {}): Grant[] {
    const { botId, groupId, connectorId, ...page } = GrantPageSchema.parse(query);
    const scope: [string, string | null][] = groupId
      ? [["group_id", groupId]]
      : botId
        ? [
            ["bot_id", botId],
            ["group_id", null],
          ]
        : [];
    return readPage(
      this.db,
      "grants",
      columns,
      "created_at",
      page,
      [
        ...scope,
        ...(connectorId
          ? ([
              ["json_extract(scope, '$.connectorId')", connectorId],
              ["json_extract(scope, '$.kind')", "connector_tool"],
            ] as [string, string][])
          : []),
        ["revoked_at", null],
      ],
      scope,
    ).map(parseGrant);
  }

  revoke(id: string): boolean {
    return (
      this.db
        .prepare("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(new Date().toISOString(), id).changes > 0
    );
  }
}
