import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { assertSafeSecretValue } from "@pibot/secrets";
import { assertSupportedCredential } from "./claude-subscription.ts";

export function literalCredentials(): CredentialStore {
  const entries = new Map<string, Credential>();
  const queues = new Map<string, Promise<unknown>>();
  function serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const result = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
    queues.set(id, result);
    void result
      .finally(() => {
        if (queues.get(id) === result) queues.delete(id);
      })
      .catch(() => {});
    return result;
  }
  return {
    async read(id, options) {
      options?.signal?.throwIfAborted();
      return structuredClone(entries.get(id));
    },
    async list(options) {
      options?.signal?.throwIfAborted();
      return [...entries].map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    },
    modify(id, update, options) {
      return serialize(id, async () => {
        options?.signal?.throwIfAborted();
        const next = await update(structuredClone(entries.get(id)));
        options?.signal?.throwIfAborted();
        if (next !== undefined) {
          if (next.type !== "api_key" || next.key === undefined || next.env !== undefined)
            throw new TypeError("Only literal API keys are supported");
          assertSupportedCredential(next.key);
          assertSafeSecretValue(next.key);
          entries.set(id, { type: "api_key", key: next.key });
        }
        return structuredClone(entries.get(id));
      });
    },
    delete(id, options) {
      return serialize(id, async () => {
        options?.signal?.throwIfAborted();
        entries.delete(id);
      });
    },
  };
}
