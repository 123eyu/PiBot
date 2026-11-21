import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { type Credential, CredentialSchema } from "@pibot/credentials-contract/full";
import { transaction } from "@pibot/storage";

/** Fields of a saved account apart from its secret blob (username + password, encrypted). */
export interface SiteCredentialFields {
  id?: string;
  site: string;
  label: string;
  note: string;
  botIds: string[];
  hasTotp?: boolean;
}
/** What brain needs to offer and fill an account; still no plaintext. */
export interface SiteCredentialMatch {
  id: string;
  site: string;
  label: string;
  lastUsedAt: string | null;
}

const columns = `id, site, label, note, has_totp AS hasTotp, created_at AS createdAt, updated_at AS updatedAt,
  last_used_at AS lastUsedAt`;

/**
 * Saved website accounts. The secret column is opaque ciphertext produced by brain's
 * SecretCipher; this repository never sees or returns plaintext, and the public shape it
 * returns has no secret at all. Writes and their audit entries share one transaction.
 * Since T17 the note is inside the ciphertext too; the `note` column only holds notes written
 * before that, until brain moves them (brain passes "" for every new write).
 */
export class SiteCredentialsRepo {
  constructor(private readonly db: DatabaseSync) {}

  private botsOf(ids: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>(ids.map((id) => [id, []]));
    if (!ids.length) return result;
    const rows = this.db
      .prepare(
        `SELECT credential_id AS credentialId, bot_id AS botId FROM site_credential_bots
        WHERE credential_id IN (${ids.map(() => "?").join(",")}) ORDER BY bot_id`,
      )
      .all(...ids);
    for (const row of rows) result.get(String(row.credentialId))?.push(String(row.botId));
    return result;
  }

  private parse(rows: Record<string, unknown>[]): Credential[] {
    const bots = this.botsOf(rows.map((row) => String(row.id)));
    return rows.map((row) =>
      CredentialSchema.parse({
        ...row,
        hasTotp: row.hasTotp === 1,
        botIds: bots.get(String(row.id)) ?? [],
        hasPassword: true,
      }),
    );
  }

  /** Ordered by site, then display name; `after` continues after that record. */
  list(query: { botId?: string; after?: string; limit?: number } = {}): Credential[] {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
    const rows = this.db
      .prepare(
        `SELECT ${columns} FROM site_credentials c
        WHERE (?1 IS NULL OR EXISTS (SELECT 1 FROM site_credential_bots b
            WHERE b.credential_id = c.id AND b.bot_id = ?1))
          AND (?2 IS NULL OR (c.site, c.label, c.id) >
            (SELECT site, label, id FROM site_credentials WHERE id = ?2))
        ORDER BY c.site, c.label, c.id LIMIT ?3`,
      )
      .all(query.botId ?? null, query.after ?? null, limit);
    return this.parse(rows);
  }

  get(id: string): Credential | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM site_credentials WHERE id = ?`).get(id);
    return row ? this.parse([row])[0] : undefined;
  }

  /** Records the Bot may use (unchecked Bots neither see nor use them). */
  forBot(botId: string): SiteCredentialMatch[] {
    return this.db
      .prepare(
        `SELECT c.id, c.site, c.label, c.last_used_at AS lastUsedAt FROM site_credentials c
        JOIN site_credential_bots b ON b.credential_id = c.id
        WHERE b.bot_id = ? ORDER BY c.site, c.label, c.id LIMIT 1000`,
      )
      .all(botId)
      .map((row) => ({
        id: String(row.id),
        site: String(row.site),
        label: String(row.label),
        lastUsedAt: row.lastUsedAt == null ? null : String(row.lastUsedAt),
      }));
  }

  allowed(id: string, botId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM site_credential_bots WHERE credential_id = ? AND bot_id = ?")
        .get(id, botId) !== undefined
    );
  }

  secret(id: string): Uint8Array | undefined {
    const row = this.db.prepare("SELECT secret FROM site_credentials WHERE id = ?").get(id);
    return row ? (row.secret as Uint8Array) : undefined;
  }

  /** A pre-T17 plaintext note (the column is empty for everything written since). */
  legacyNote(id: string): string {
    const row = this.db.prepare("SELECT note FROM site_credentials WHERE id = ?").get(id);
    return row ? String(row.note) : "";
  }

  legacyNotes(): { id: string; note: string }[] {
    return this.db
      .prepare("SELECT id, note FROM site_credentials WHERE note <> '' ORDER BY id LIMIT 10000")
      .all()
      .map((row) => ({ id: String(row.id), note: String(row.note) }));
  }

  /**
   * Replaces the blob with one that now carries the note and clears the plaintext column. The
   * note guard skips a record edited meanwhile; that edit already moved its note.
   */
  moveNote(id: string, note: string, secret: Uint8Array): void {
    this.db
      .prepare("UPDATE site_credentials SET secret = ?, note = '' WHERE id = ? AND note = ?")
      .run(secret, id, note);
  }

  private setBots(id: string, botIds: string[]) {
    this.db.prepare("DELETE FROM site_credential_bots WHERE credential_id = ?").run(id);
    const insert = this.db.prepare(
      // Bots deleted meanwhile are skipped instead of failing the whole save.
      `INSERT INTO site_credential_bots (credential_id, bot_id)
      SELECT ?, id FROM bots WHERE id = ? ON CONFLICT DO NOTHING`,
    );
    for (const botId of new Set(botIds)) insert.run(id, botId);
  }

  create(
    fields: SiteCredentialFields,
    secret: Uint8Array,
    audit: (value: Credential) => void,
  ): Credential {
    return transaction(this.db, () => {
      const id = fields.id ?? randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO site_credentials (id, site, label, note, secret, has_totp, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, fields.site, fields.label, fields.note, secret, fields.hasTotp ? 1 : 0, now, now);
      this.setBots(id, fields.botIds);
      const value = this.get(id) as Credential;
      audit(value);
      return value;
    });
  }

  update(
    id: string,
    fields: SiteCredentialFields,
    secret: Uint8Array | undefined,
    audit: (before: Credential, after: Credential) => void,
  ): Credential | undefined {
    return transaction(this.db, () => {
      const before = this.get(id);
      if (!before) return undefined;
      this.db
        .prepare(
          `UPDATE site_credentials SET site = ?, label = ?, note = ?, has_totp = ?,
          secret = COALESCE(?, secret), updated_at = ? WHERE id = ?`,
        )
        .run(
          fields.site,
          fields.label,
          fields.note,
          fields.hasTotp ? 1 : 0,
          secret ?? null,
          new Date().toISOString(),
          id,
        );
      this.setBots(id, fields.botIds);
      const after = this.get(id) as Credential;
      audit(before, after);
      return after;
    });
  }

  remove(id: string, audit: (value: Credential) => void): boolean {
    return transaction(this.db, () => {
      const value = this.get(id);
      if (!value) return false;
      this.db.prepare("DELETE FROM site_credentials WHERE id = ?").run(id);
      audit(value);
      return true;
    });
  }

  touch(id: string): void {
    this.db
      .prepare("UPDATE site_credentials SET last_used_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }
}
