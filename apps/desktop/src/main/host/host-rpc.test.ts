import { createPeer, HostMethods } from "@pibot/protocol";
import { createRedactor } from "@pibot/secrets";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryPorts } from "../../test-port.ts";
import { createEnvReader } from "../brain/env-detect.ts";
import { registerHostRpc } from "./host-rpc.ts";

const disposables: { dispose(): void }[] = [];
afterEach(() => {
  for (const peer of disposables.splice(0)) peer.dispose();
});

function fixture(available = true, backend = "keychain") {
  const [a, b] = memoryPorts();
  const storage = {
    isAsyncEncryptionAvailable: async () => available,
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: vi.fn(async (plain: string) => Buffer.from(`encrypted:${plain}`)),
    decryptStringAsync: vi.fn(async (cipher: Buffer) => ({
      result: cipher.toString().slice("encrypted:".length),
      shouldReEncrypt: false,
    })),
  };
  const redactor = createRedactor();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const openExternal = vi.fn(async () => {});
  const setLoginItem = vi.fn(async () => {});
  const host = registerHostRpc(a, {
    storage,
    redactor,
    logger,
    openExternal,
    setLoginItem,
    env: createEnvReader(
      { OPENAI_API_KEY: "fake-key", PATH: "private" },
      ["OPENAI_API_KEY"],
      "darwin",
    ),
  });
  const client = createPeer(b, { methods: HostMethods, events: {}, timeoutMs: 1000 });
  disposables.push(host, client);
  return { client, storage, redactor, logger, openExternal, setLoginItem };
}

describe("host RPC security boundary", () => {
  it.each([
    [false, "unknown"],
    [true, "basic_text"],
  ] as const)("refuses insecure storage (%s, %s)", async (available, backend) => {
    const { client, storage } = fixture(available, backend);
    expect(await client.call("host.secrets.isAvailable", undefined)).toBe(false);
    await expect(client.call("host.secrets.encrypt", { plain: "fake-value" })).rejects.toThrow();
    await expect(
      client.call("host.secrets.decrypt", { cipher: new Uint8Array([1]) }),
    ).rejects.toThrow();
    expect(storage.encryptStringAsync).not.toHaveBeenCalled();
    expect(storage.decryptStringAsync).not.toHaveBeenCalled();
  });
  it("round-trips typed ciphertext and registers plaintext for redaction", async () => {
    const { client, redactor, logger } = fixture();
    const cipher = await client.call("host.secrets.encrypt", { plain: "fake-value" });
    expect(cipher).toBeInstanceOf(Uint8Array);
    expect(await client.call("host.secrets.decrypt", { cipher })).toBe("fake-value");
    expect(redactor.redact("log fake-value")).toBe("log [REDACTED]");
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("fake-value");
    await expect(client.call("host.secrets.encrypt", { plain: "!command" })).rejects.toThrow();
  });
  it("detects only names and refuses reads outside the provider allowlist", async () => {
    const { client } = fixture();
    expect(await client.call("host.env.detect", undefined)).toEqual(["OPENAI_API_KEY"]);
    expect(await client.call("host.env.read", { name: "PATH" })).toBeNull();
    expect(await client.call("host.env.read", { name: "OPENAI_API_KEY" })).toBe("fake-key");
  });
  it("audits external links without logging paths, queries, or keys", async () => {
    const { client, openExternal, logger, setLoginItem } = fixture();
    await expect(client.call("host.openExternal", { url: "file:///private" })).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
    const url = "https://example.com/user-content?token=fake-value";
    await client.call("host.openExternal", { url });
    expect(openExternal).toHaveBeenCalledWith(url);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("fake-value");
    await client.call("host.setLoginItem", { openAtLogin: false });
    expect(setLoginItem).toHaveBeenCalledWith(false);
  });
});
