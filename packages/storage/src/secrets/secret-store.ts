import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CredentialTotpSecretSchema, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { assertSafeSecretValue, keyHint, type Redactor, type SecretCipher } from "@pibot/secrets";

const warmConcurrency = 8;

export class SecretStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: SecretCipher,
    private readonly redactor: Redactor,
  ) {}

  async set(scope: string, name: string, value: string): Promise<void> {
    const commit = await this.prepareSet(scope, name, value);
    commit();
  }

  /** Encryption may cross host RPC: finish it before entering a synchronous SQLite transaction. */
  async prepareSet(scope: string, name: string, value: string): Promise<() => void> {
    assertSafeSecretValue(value);
    if (!(await this.cipher.isAvailable()))
      throw new RpcError(RpcErrorCodes.secretsUnavailable, "secrets_unavailable");
    const ciphertext = await this.cipher.encrypt(value);
    this.register(scope, name, value);
    const hint = keyHint(value) ?? null;
    return () =>
      this.db
        .prepare(`INSERT INTO secrets (id, scope, name, ciphertext, hint, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(scope, name) DO UPDATE
      SET ciphertext = excluded.ciphertext, hint = excluded.hint, last_used_at = NULL`)
        .run(randomUUID(), scope, name, ciphertext, hint, new Date().toISOString());
  }

  async get(scope: string, name: string): Promise<string | undefined> {
    const row = this.db
      .prepare("SELECT ciphertext FROM secrets WHERE scope = ? AND name = ?")
      .get(scope, name);
    if (!row) return undefined;
    if (!(await this.cipher.isAvailable()))
      throw new RpcError(RpcErrorCodes.secretsUnavailable, "secrets_unavailable");
    const value = await this.cipher.decrypt(row.ciphertext as Uint8Array);
    assertSafeSecretValue(value);
    // Undecrypted secrets are absent from this process and cannot be emitted by it.
    // Register plaintext before returning it to any caller that could produce diagnostics.
    this.register(scope, name, value);
    this.db
      .prepare(`UPDATE secrets SET last_used_at = ?, hint = COALESCE(hint, ?)
        WHERE scope = ? AND name = ? AND ciphertext = ?`)
      .run(
        new Date().toISOString(),
        keyHint(value) ?? null,
        scope,
        name,
        row.ciphertext as Uint8Array,
      );
    return value;
  }

  private register(scope: string, name: string, value: string) {
    const named = this.redactor as Redactor & { addNamed?(name: string, value: string): void };
    if (scope === "user-secret" && /^[A-Z][A-Z0-9_]{0,63}$/.test(name) && named.addNamed)
      named.addNamed(name, value);
    else {
      this.redactor.add(value);
      if (scope === "credential-totp" && named.addNamed) {
        // Warm raw Base32 too: tools may encounter it without the enclosing encrypted JSON.
        let decoded: unknown;
        try {
          decoded = JSON.parse(value);
        } catch {
          throw new Error("Saved account authenticator unavailable");
        }
        const parsed = CredentialTotpSecretSchema.safeParse(decoded);
        if (!parsed.success) throw new Error("Saved account authenticator unavailable");
        named.addNamed("TOTP", parsed.data.secret);
      }
    }
  }

  /** Seed output/write-out protection before tools can read files, even if a secret was never used. */
  async warm(signal: AbortSignal): Promise<void> {
    let after = "";
    for (;;) {
      signal.throwIfAborted();
      const rows = this.db
        .prepare("SELECT id,scope,name,ciphertext FROM secrets WHERE id > ? ORDER BY id LIMIT 100")
        .all(after);
      if (!rows.length) return;
      if (!(await this.cipher.isAvailable()))
        throw new RpcError(RpcErrorCodes.secretsUnavailable, "secrets_unavailable");
      // On desktop every decrypt is a host RPC round trip. One at a time, startup
      // paid the round-trip latency once per stored secret; a few in flight hide it while the
      // host still decrypts serially. Registration order does not matter to the redactor.
      let next = 0;
      const worker = async () => {
        while (next < rows.length) {
          const row = rows[next++] as (typeof rows)[number];
          signal.throwIfAborted();
          const value = await this.cipher.decrypt(row.ciphertext as Uint8Array);
          assertSafeSecretValue(value);
          this.register(String(row.scope), String(row.name), value);
        }
      };
      // A failed worker must not release the owner while sibling host decrypts still run.
      const settled = await Promise.allSettled(
        Array.from({ length: Math.min(warmConcurrency, rows.length) }, worker),
      );
      const failure = settled.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      after = String(rows.at(-1)?.id);
    }
  }

  has(scope: string, name: string): boolean {
    return (
      this.db.prepare("SELECT id FROM secrets WHERE scope = ? AND name = ?").get(scope, name) !==
      undefined
    );
  }

  remove(scope: string, name: string): boolean {
    return (
      this.db.prepare("DELETE FROM secrets WHERE scope = ? AND name = ?").run(scope, name).changes >
      0
    );
  }

  /** Installation cleanup uses an exact generated prefix; an empty prefix must never widen it. */
  removePrefix(scope: string, prefix: string): number {
    if (!prefix) throw new TypeError("Secret prefix must not be empty");
    return Number(
      this.db
        .prepare("DELETE FROM secrets WHERE scope = ? AND substr(name, 1, ?) = ?")
        .run(scope, prefix.length, prefix).changes,
    );
  }

  hint(scope: string, name: string): string | undefined {
    const row = this.db
      .prepare("SELECT hint FROM secrets WHERE scope = ? AND name = ?")
      .get(scope, name);
    return row?.hint == null ? undefined : String(row.hint);
  }
}
