import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { BrainHost } from "../../packages/brain-app/src/index.ts";

export function ephemeralSecrets(): { secrets: BrainHost["secrets"]; dispose(): void } {
  // The database may outlive a failed shutdown; its encryption key must never go to disk.
  const key = randomBytes(32);
  let disposed = false;
  const available = () => {
    if (disposed) throw new Error("eval_secrets_disposed");
  };
  return {
    secrets: {
      isAvailable: async () => !disposed,
      encrypt: async (plain) => {
        available();
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
        return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
      },
      decrypt: async (bytes) => {
        available();
        const envelope = Buffer.from(bytes);
        if (envelope.length < 28) throw new Error("eval_secrets_invalid");
        const decipher = createDecipheriv("aes-256-gcm", key, envelope.subarray(0, 12));
        decipher.setAuthTag(envelope.subarray(12, 28));
        return Buffer.concat([decipher.update(envelope.subarray(28)), decipher.final()]).toString(
          "utf8",
        );
      },
    },
    dispose() {
      disposed = true;
      key.fill(0);
    },
  };
}
