import * as SecureStore from "expo-secure-store";
import { type KeyVault, vaultName } from "./vault.ts";

export const nativeVault: KeyVault = {
  get: (computerId, grantId) => SecureStore.getItemAsync(vaultName(computerId, grantId)),
  async set(computerId, grantId, key) {
    // A key with up to 32 headers of 4 KiB each (OfflineHeadersSchema).
    if (key.length > 140_000) throw new Error("offline_key_limit");
    // This device only and only while unlocked: a backup or another phone never gets the key.
    await SecureStore.setItemAsync(vaultName(computerId, grantId), key, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  remove: (computerId, grantId) => SecureStore.deleteItemAsync(vaultName(computerId, grantId)),
};
