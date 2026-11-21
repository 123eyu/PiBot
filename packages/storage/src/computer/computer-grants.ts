import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  type ComputerAlways,
  ComputerAlwaysSchema,
  type ComputerApp,
  ComputerAppListSchema,
  type ComputerGrant,
  ComputerGrantSchema,
  IdSchema,
  type Page,
} from "@pibot/protocol-base";
import { transaction } from "../database/database.ts";
import { readPage } from "../database/paging.ts";
import { AppBlocklistRepo } from "./app-blocklist.ts";

/** Grants are looked up by this hash so the raw token never needs to be stored or logged. */
export function computerTokenHash(token: string): string {
  if (token.length < 32) throw new TypeError("Weak computer token");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const columns = `id,bot_id AS botId,run_id AS runId,apps,duration,expires_at AS expiresAt,
  foreground_ask AS foregroundAsk,allow_coordinates AS allowCoordinates,
  created_at AS createdAt,revoked_at AS revokedAt`;
function parseGrant(row: Record<string, unknown>): ComputerGrant {
  return ComputerGrantSchema.parse({
    ...row,
    apps: JSON.parse(String(row.apps)),
    foregroundAsk: row.foregroundAsk === 1,
    allowCoordinates: row.allowCoordinates === 1,
  });
}
function assertNotBlocked(db: DatabaseSync, appIds: readonly string[]): void {
  // Blocklist wins over any grant or always-list, checked in the same transaction.
  if (new AppBlocklistRepo(db).blockedAmong(appIds).size) throw new TypeError("Blocked app");
}

export type CreateComputerGrant = Omit<ComputerGrant, "id" | "createdAt" | "revokedAt"> & {
  approvalId: string | null;
  tokenHash: string;
};

export class ComputerGrantsRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateComputerGrant): ComputerGrant {
    const now = new Date().toISOString();
    const { approvalId: rawApprovalId, tokenHash, ...fields } = input;
    const grant = ComputerGrantSchema.parse({
      ...fields,
      id: randomUUID(),
      createdAt: now,
      revokedAt: null,
    });
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new TypeError("Invalid token hash");
    if (Date.parse(grant.expiresAt) <= Date.parse(now))
      throw new TypeError("Grant already expired");
    const approvalId = rawApprovalId === null ? null : IdSchema.parse(rawApprovalId);
    return transaction(this.db, () => {
      assertNotBlocked(this.db, grant.apps);
      this.db
        .prepare(`INSERT INTO computer_grants(id,bot_id,run_id,approval_id,apps,duration,expires_at,
          foreground_ask,allow_coordinates,token_hash,created_at,revoked_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`)
        .run(
          grant.id,
          grant.botId,
          grant.runId,
          approvalId,
          JSON.stringify(grant.apps),
          grant.duration,
          grant.expiresAt,
          grant.foregroundAsk ? 1 : 0,
          grant.allowCoordinates ? 1 : 0,
          tokenHash,
          grant.createdAt,
        );
      return grant;
    });
  }

  get(id: string): ComputerGrant | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM computer_grants WHERE id=?`)
      .get(IdSchema.parse(id));
    return row ? parseGrant(row) : undefined;
  }

  /** Host-side check for each driver call: unrevoked, unexpired, and still bound to its run. */
  findActiveByToken(tokenHash: string, now = new Date()): ComputerGrant | undefined {
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM computer_grants WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?`,
      )
      .get(tokenHash, now.toISOString());
    return row ? parseGrant(row) : undefined;
  }

  activeForRun(runId: string, now = new Date()): ComputerGrant[] {
    return this.db
      .prepare(
        `SELECT ${columns} FROM computer_grants WHERE run_id=? AND revoked_at IS NULL AND expires_at>?
          ORDER BY created_at DESC,id DESC LIMIT 20`,
      )
      .all(IdSchema.parse(runId), now.toISOString())
      .map(parseGrant);
  }

  list(query: { botId?: string; runId?: string } = {}, page: Page = {}): ComputerGrant[] {
    const scope: [string, string][] = [];
    if (query.botId) scope.push(["bot_id", IdSchema.parse(query.botId)]);
    if (query.runId) scope.push(["run_id", IdSchema.parse(query.runId)]);
    return readPage(this.db, "computer_grants", columns, "created_at", page, scope).map(parseGrant);
  }

  revoke(id: string): boolean {
    return (
      this.db
        .prepare("UPDATE computer_grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
        .run(new Date().toISOString(), IdSchema.parse(id)).changes > 0
    );
  }

  /** Run end or stop invalidates every token bound to it. */
  revokeRun(runId: string): number {
    return Number(
      this.db
        .prepare("UPDATE computer_grants SET revoked_at=? WHERE run_id=? AND revoked_at IS NULL")
        .run(new Date().toISOString(), IdSchema.parse(runId)).changes,
    );
  }
}

/** The "always allow" app list for one Bot. */
export class BotComputerAlwaysRepo {
  constructor(private readonly db: DatabaseSync) {}

  get(botId: string): ComputerAlways | null {
    const row = this.db
      .prepare(
        "SELECT bot_id AS botId,apps,updated_at AS updatedAt FROM bot_computer_always WHERE bot_id=?",
      )
      .get(IdSchema.parse(botId));
    return row ? ComputerAlwaysSchema.parse({ ...row, apps: JSON.parse(String(row.apps)) }) : null;
  }

  /** Rejects an empty list and any blocklisted app; coordinates cannot be expressed at all. */
  set(botId: string, apps: ComputerApp[]): ComputerAlways {
    const value = ComputerAlwaysSchema.parse({
      botId,
      apps: ComputerAppListSchema.parse(apps),
      updatedAt: new Date().toISOString(),
    });
    return transaction(this.db, () => {
      assertNotBlocked(
        this.db,
        value.apps.map((app) => app.id),
      );
      this.db
        .prepare(`INSERT INTO bot_computer_always(bot_id,apps,updated_at) VALUES (?,?,?)
          ON CONFLICT(bot_id) DO UPDATE SET apps=excluded.apps,updated_at=excluded.updated_at`)
        .run(value.botId, JSON.stringify(value.apps), value.updatedAt);
      return value;
    });
  }

  clear(botId: string): boolean {
    return (
      this.db.prepare("DELETE FROM bot_computer_always WHERE bot_id=?").run(IdSchema.parse(botId))
        .changes > 0
    );
  }
}
