import * as SecureStore from "expo-secure-store";
import { openDatabaseAsync } from "expo-sqlite";
import type { LocalData, SecretData } from "./types.ts";

export async function openLocalData(): Promise<LocalData> {
  const db = await openDatabaseAsync("mobile-cache.db");
  try {
    await db.execAsync(
      "CREATE TABLE IF NOT EXISTS mobile_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  function tracked<T>(work: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error("storage_closed"));
    const result = work();
    pending.add(result);
    void result
      .finally(() => pending.delete(result))
      .catch(() => {
        /* The original caller observes failure. */
      });
    return result;
  }
  return {
    get: (key) =>
      tracked(async () => {
        const row = await db.getFirstAsync<{ value: string }>(
          "SELECT value FROM mobile_cache WHERE key=?",
          key,
        );
        if (!row) return undefined;
        if (row.value.length > 1_200_000) throw new Error("cache_limit");
        return JSON.parse(row.value);
      }),
    put: (key, value) =>
      tracked(async () => {
        const json = JSON.stringify(value);
        if (json.length > 1_000_000) throw new Error("cache_limit");
        // REPLACE gives a rewritten row a new rowid, so the cap below drops the least recently
        // written copies; an in-place update kept the first rowid and evicted the oldest key
        // (the conversation list) first, however often it was refreshed.
        await db.runAsync("INSERT OR REPLACE INTO mobile_cache(key,value) VALUES(?,?)", key, json);
        // One catalog pass alone writes ~150 settings rows (copy + stamp each), next to 30
        // topic histories and lists; the copies cold start renders from are never evicted here
        // (they are one row each per computer and go with the computer on unpair).
        await db.runAsync(
          `DELETE FROM mobile_cache WHERE key IN (SELECT key FROM mobile_cache WHERE key LIKE 'cache:%'
            AND key NOT GLOB 'cache:*:conversations' AND key NOT GLOB 'cache:*:approvals'
            AND key NOT GLOB 'cache:*:tasks' AND key NOT GLOB 'cache:*:presence'
            AND key NOT GLOB 'cache:*:history-index'
            ORDER BY rowid DESC LIMIT -1 OFFSET 512)`,
        );
      }),
    removePrefix: (prefix) =>
      tracked(async () => {
        await db.runAsync(
          "DELETE FROM mobile_cache WHERE substr(key,1,?)=?",
          prefix.length,
          prefix,
        );
      }),
    close() {
      closed = true;
      closing ??= (async () => {
        await Promise.allSettled([...pending]);
        await db.closeAsync();
      })();
      return closing;
    },
  };
}
export const secretData: SecretData = {
  get: (id) => SecureStore.getItemAsync(`pibot.link.${id}`),
  async set(id, value) {
    if (value.length > 2000) throw new Error("credential_limit");
    await SecureStore.setItemAsync(`pibot.link.${id}`, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  remove: (id) => SecureStore.deleteItemAsync(`pibot.link.${id}`),
};
