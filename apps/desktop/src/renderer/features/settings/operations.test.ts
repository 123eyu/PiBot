import { createPeer, Events, Methods, type Port, RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { Peer } from "@pibot/renderer-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  choosePiModel,
  providerIdentity,
  registerOllama,
  requirePeer,
  SetupError,
  saveKey,
  testProvider,
  validateCustom,
  writeCredential,
} from "./operations.ts";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});
function fixture() {
  const listeners = [new Set<(value: unknown) => void>(), new Set<(value: unknown) => void>()];
  const port = (side: number): Port => ({
    post(value) {
      queueMicrotask(() => {
        for (const listener of listeners[1 - side] ?? []) listener(structuredClone(value));
      });
    },
    onMessage(listener) {
      listeners[side]?.add(listener);
      return () => {
        listeners[side]?.delete(listener);
      };
    },
  });
  const client = createPeer(port(0), { methods: Methods, events: Events });
  const server = createPeer(port(1), { methods: Methods, events: Events });
  disposers.push(() => {
    client.dispose();
    server.dispose();
  });
  const botId = "00000000-0000-4000-8000-000000000001";
  const bot = {
    id: botId,
    name: "Pi",
    isMain: true,
    category: "chat" as const,
    avatarShape: "blob",
    avatarColor: "orange",
    avatarEyes: "marks",
    modelProvider: null,
    modelId: null,
    thinkingLevel: "medium" as const,
    systemPrompt: "",
    createdAt: "2026-10-09T00:00:00Z",
    updatedAt: "2026-10-09T00:00:00Z",
  };
  const updates = vi.fn(async ({ defaultModel }) => ({
    defaultModel,
    language: "system" as const,
    theme: "system" as const,
    onboardingCompleted: false,
    openAtLogin: true,
    showTrayIcon: true,
    closeToTrayHintShown: false,
  }));
  server.handle("bots.list", async () => [bot]);
  server.handle("settings.set", updates);
  const model = {
    provider: "openai",
    id: "test-model",
    name: "Test model",
    contextWindow: 32000,
    input: ["text"] as ["text"],
    reasoning: false,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
  server.handle("models.list", async () => [model]);
  return { client, server, updates, botId, model };
}

describe("setup RPC operations", () => {
  it.each(["", "!shell", " value", "value ", "line\nbreak"])(
    "rejects unsafe key %j before any RPC",
    async (key) => {
      const call = vi.fn();
      await expect(saveKey({ call } as unknown as Peer, "openai", key)).rejects.toMatchObject({
        key: "models.keyInvalid",
      });
      expect(call).not.toHaveBeenCalled();
    },
  );
  it("sends a safe key through the typed RPC without reading credentials back", async () => {
    const { client, server } = fixture();
    const save = vi.fn(async () => ({ ok: true as const }));
    server.handle("providers.setApiKey", save);
    await saveKey(client, "openai", "fake-key-1234");
    expect(save).toHaveBeenCalledWith(
      { providerId: "openai", apiKey: "fake-key-1234" },
      { signal: expect.any(AbortSignal) },
    );
  });
  it("maps the dedicated secret-store code without reclassifying internal errors", async () => {
    await expect(
      writeCredential(async () => {
        throw new RpcError(RpcErrorCodes.secretsUnavailable, "secrets_unavailable");
      }),
    ).rejects.toMatchObject({ key: "models.noSecretStore" });
    const { client, server } = fixture();
    server.handle("providers.setApiKey", async () => {
      throw new Error("Secret encryption unavailable");
    });
    await expect(saveKey(client, "openai", "fake-key")).rejects.toMatchObject({
      code: RpcErrorCodes.internal,
    });
  });
  it("does not mislabel transport or validation failures as a missing keyring", async () => {
    const error = new RpcError(-32602, "bad parameters");
    await expect(
      writeCredential(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
  it.each(["auth_failed", "network", "rate_limited"] as const)(
    "stops a failed test with the %s reason",
    async (error) => {
      const { client, server, updates } = fixture();
      server.handle("providers.test", async () => ({ ok: false, error }));
      await expect(
        testProvider(client, "openai").then(() => choosePiModel(client, "openai")),
      ).rejects.toMatchObject({ key: `errors.${error}` });
      expect(updates).not.toHaveBeenCalled();
    },
  );
  it("selects Pi's requested model only from available models", async () => {
    const { client, updates } = fixture();
    await choosePiModel(client, "openai", "test-model");
    expect(updates).toHaveBeenCalledWith(
      {
        defaultModel: {
          provider: "openai",
          id: "test-model",
          thinkingLevel: "off",
          thinkingPreference: "medium",
        },
        initializeMainBot: true,
      },
      { signal: expect.any(AbortSignal) },
    );
    updates.mockClear();
    await expect(choosePiModel(client, "unconfigured")).rejects.toMatchObject({
      key: "setup.noModels",
    });
    expect(updates).not.toHaveBeenCalled();
  });
  it("registers the explicitly selected Ollama model before assigning it to Pi", async () => {
    const { client, server, model, updates } = fixture();
    const upsert = vi.fn(async () => ({ id: "ollama" }));
    server.handle("customProviders.upsert", upsert);
    server.handle("models.list", async () => [{ ...model, provider: "ollama", id: "qwen3" }]);
    await registerOllama(client, "http://127.0.0.1:11434/v1", "qwen3");
    expect(upsert).toHaveBeenCalledWith(
      {
        id: "ollama",
        name: "Ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        compat: { supportsDeveloperRole: false },
        models: [{ id: "qwen3" }],
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(upsert.mock.invocationCallOrder[0]).toBeLessThan(
      updates.mock.invocationCallOrder[0] ?? 0,
    );
  });
  it("keeps Anthropic API and subscription identities distinct", () => {
    expect(providerIdentity({ id: "anthropic", auth: "apiKey" })).not.toBe(
      providerIdentity({ id: "anthropic", auth: "oauth" }),
    );
  });
  it("rejects absent peers rather than treating writes as completed", () => {
    expect(() => requirePeer(null)).toThrow(SetupError);
  });
});

describe("custom provider boundary", () => {
  const config = {
    name: "Gateway",
    baseUrl: "https://gateway.example/v1",
    api: "openai-completions" as const,
    models: [{ id: "model" }],
  };
  it.each([
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ] as const)("accepts the %s interface", (api) => {
    expect(validateCustom({ ...config, api }).api).toBe(api);
  });
  it("supports explicit credential preservation and header clearing", () => {
    expect(validateCustom(config)).not.toHaveProperty("apiKey");
    expect(validateCustom(config)).not.toHaveProperty("headers");
    expect(validateCustom({ ...config, headers: {} }).headers).toEqual({});
  });
  it.each([
    { baseUrl: "https://user:password@gateway.example" },
    { baseUrl: "https://gateway.example/v1?api_key=value" },
    { headers: { "Bad Header": "value" } },
    { headers: { Authorization: "value", authorization: "value" } },
    { headers: { Authorization: "!shell" } },
    { headers: { Authorization: "line\nbreak" } },
    { models: [] },
    { models: [{ id: "model" }, { id: "model" }] },
    { apiKey: "!command" },
  ])("rejects unsafe or ambiguous configuration %j", (patch) => {
    expect(() => validateCustom({ ...config, ...patch })).toThrow(SetupError);
  });
});
