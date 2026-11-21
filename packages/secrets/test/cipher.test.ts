import type {
  KernelHostParams as HostParams,
  KernelHostResults as HostResults,
} from "@pibot/protocol-base";
import { expect, it } from "vitest";
import type { MasterPasswordCipher, SecretCipher } from "../src/index.ts";

// Deliberately has no production Node encryption backend or plaintext fallback.
class UnavailableMasterPasswordCipher implements MasterPasswordCipher {
  async isAvailable(): Promise<boolean> {
    return false;
  }
  async unlock(_masterPassword: string): Promise<void> {
    throw new Error("Master-password encryption is not implemented yet");
  }
  async lock(): Promise<void> {}
  async encrypt(_plain: string): Promise<Uint8Array> {
    throw new Error("Secret encryption unavailable");
  }
  async decrypt(_cipher: Uint8Array): Promise<string> {
    throw new Error("Secret encryption unavailable");
  }
}

it("allows injection of a pure Node host RPC test double with protocol-compatible types", async () => {
  const encrypt = async ({
    plain,
  }: HostParams["host.secrets.encrypt"]): Promise<HostResults["host.secrets.encrypt"]> =>
    new TextEncoder().encode(plain);
  const decrypt = async ({
    cipher,
  }: HostParams["host.secrets.decrypt"]): Promise<HostResults["host.secrets.decrypt"]> =>
    new TextDecoder().decode(cipher);
  // Identity encoding is strictly a local test double, never a production cipher export.
  const cipher: SecretCipher = {
    isAvailable: async () => true,
    encrypt: (plain) => encrypt({ plain }),
    // The protocol infers ArrayBuffer-backed bytes; copy a potentially SharedArrayBuffer view.
    decrypt: (value) => decrypt({ cipher: new Uint8Array(value) }),
  };
  expect(await cipher.isAvailable()).toBe(true);
  expect(await cipher.decrypt(await cipher.encrypt("fake-test-key"))).toBe("fake-test-key");
});

it("keeps the master-password stub unavailable and refuses all encryption operations", async () => {
  const cipher: MasterPasswordCipher = new UnavailableMasterPasswordCipher();
  expect(await cipher.isAvailable()).toBe(false);
  await expect(cipher.unlock("fake-master-password")).rejects.toThrow("not implemented yet");
  await expect(cipher.encrypt("fake-key")).rejects.toThrow("unavailable");
  await expect(cipher.decrypt(new Uint8Array([1]))).rejects.toThrow("unavailable");
  await cipher.lock();
  expect(await cipher.isAvailable()).toBe(false);
});
