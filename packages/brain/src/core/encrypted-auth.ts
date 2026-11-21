import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OAuthCredential } from "@pibot/agent";
import { RpcError, SafeSecretSchema } from "@pibot/protocol-base";
import type { Redactor, SecretCipher } from "@pibot/secrets";
import { SecretStore, transaction } from "@pibot/storage";
import { z } from "zod";

const oauth = z
  .object({
    type: z.literal("oauth"),
    access: SafeSecretSchema,
    refresh: SafeSecretSchema,
    expires: z.number().finite().nonnegative(),
  })
  .catchall(z.json());
export const oauthScope = (id: string) => `provider:${id}:oauth`;
export const cloudScope = (id: string) => `provider:${id}:cloud`;
export function registerSecretText(value: string, redactor: Redactor) {
  if (SafeSecretSchema.safeParse(value).success) redactor.add(value);
  else {
    // PEM stays structured. Register escaped and body representations without weakening SafeSecret.
    redactor.add(JSON.stringify(value));
    for (const line of value.split(/\r?\n/))
      if (SafeSecretSchema.safeParse(line).success && !line.startsWith("-----")) redactor.add(line);
  }
}
export function registerSecretLeaves(value: unknown, redactor: Redactor, key = ""): void {
  if (
    typeof value === "string" &&
    /^(access|refresh|idToken|apiKey|private_key|private_key_id|client_secret|refresh_token|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN)$/.test(
      key,
    )
  )
    registerSecretText(value, redactor);
  else if (value && typeof value === "object")
    for (const [name, item] of Object.entries(value)) registerSecretLeaves(item, redactor, name);
}
export class EncryptedAuth {
  readonly secrets: SecretStore;
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly cipher: SecretCipher,
    private readonly redactor: Redactor,
  ) {
    this.secrets = new SecretStore(db, cipher, redactor);
  }
  has(id: string) {
    return this.secrets.has(oauthScope(id), "credential");
  }
  available() {
    return this.cipher.isAvailable();
  }
  async read(id: string): Promise<OAuthCredential | undefined> {
    const text = await this.secrets.get(oauthScope(id), "credential");
    if (!text) return undefined;
    const value = oauth.parse(JSON.parse(text));
    registerSecretLeaves(value, this.redactor);
    return value;
  }
  serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const work = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    const tail = work.catch(() => {});
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return work;
  }
  modify = (
    id: string,
    update: (value: OAuthCredential | undefined) => Promise<OAuthCredential | undefined>,
    signal?: AbortSignal,
  ) =>
    this.serial(id, async () => {
      signal?.throwIfAborted();
      const next = await update(await this.read(id));
      // A refresh can rotate its token while the caller cancels. Persist before releasing the shared lock.
      if (next !== undefined) await this.write(oauthScope(id), "credential", oauth.parse(next));
      return next === undefined ? this.read(id) : next;
    });
  remove = (id: string, signal?: AbortSignal) =>
    this.serial(id, async () => {
      signal?.throwIfAborted();
      this.secrets.remove(oauthScope(id), "credential");
    });
  async write(scope: string, name: string, value: unknown, afterWrite?: () => void): Promise<void> {
    const text = JSON.stringify(value);
    registerSecretLeaves(value, this.redactor);
    if (!(await this.cipher.isAvailable())) throw new RpcError(-32012, "secrets_unavailable");
    const encrypted = await this.cipher.encrypt(text);
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO secrets(id,scope,name,ciphertext,hint,created_at) VALUES(?,?,?,?,NULL,?) ON CONFLICT(scope,name) DO UPDATE SET ciphertext=excluded.ciphertext,hint=NULL,last_used_at=NULL`,
        )
        .run(randomUUID(), scope, name, encrypted, new Date().toISOString());
      afterWrite?.();
    });
    this.redactor.add(text);
  }
  async settled() {
    await Promise.all([...this.queues.values()]);
  }
}
