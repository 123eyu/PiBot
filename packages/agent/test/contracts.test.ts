import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { literalCredentials } from "../src/auth/credentials.ts";
import { BRAIN_AUTH_ENV_NAMES, sanitizeBrainEnv } from "../src/core/env.ts";
import { AgentError, mapAgentError } from "../src/core/errors.ts";
import { listProviderCatalog } from "../src/models/catalog.ts";

describe("brain environment", () => {
  it("removes the exported mapping and audited cloud names, overrides pi paths", () => {
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      BRAIN_AUTH_ENV_NAMES.map((name) => [name, "fake"]),
    );
    Object.assign(env, {
      PIBOT_DATA_DIR: join("root", "data"),
      HOME: "keep-home",
      HTTPS_PROXY: "keep-proxy",
      PI_CODING_AGENT_DIR: "foreign",
      PI_CODING_AGENT_SESSION_DIR: "foreign-sessions",
      PI_TELEMETRY: "1",
      openai_api_key: "windows-case",
    });
    sanitizeBrainEnv(env);
    for (const name of BRAIN_AUTH_ENV_NAMES) expect(env[name]).toBeUndefined();
    expect(env.openai_api_key).toBeUndefined();
    expect(env.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
    expect(env.PI_CODING_AGENT_DIR).toBe(join("root", "data", "pi"));
    expect(env).toMatchObject({
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      HOME: "keep-home",
    });
    expect(BRAIN_AUTH_ENV_NAMES).toEqual(
      expect.arrayContaining([
        "ANT_LING_API_KEY",
        "QWEN_TOKEN_PLAN_CN_API_KEY",
        "AWS_CONFIG_FILE",
        "ANTHROPIC_IDENTITY_TOKEN_FILE",
        "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
        "GH_TOKEN",
      ]),
    );
  });
  it("requires an explicit Pi Bot data directory", () => {
    expect(() => sanitizeBrainEnv({})).toThrow("dataDir");
  });
});

describe("provider catalog", () => {
  it("keeps API Key access for Anthropic and enables supported cloud providers", () => {
    const entries = listProviderCatalog();
    // The ChatGPT plan is the one sign-in provider.
    for (const entry of entries)
      if (entry.id !== "openai-chatgpt" && entry.id !== "chatgpt-codex")
        expect(entry.auth).not.toBe("oauth");
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "anthropic",
          group: "common",
          auth: "apiKey",
          available: true,
        }),
        expect.objectContaining({ id: "openai", auth: "apiKey" }),
        expect.objectContaining({ id: "azure", group: "cloud", auth: "cloud" }),
        expect.objectContaining({ id: "cloudflare-ai-gateway", group: "gateway", auth: "cloud" }),
        expect.objectContaining({ id: "ant-ling", group: "common" }),
        expect.objectContaining({ id: "ollama", group: "local", auth: "custom" }),
      ]),
    );
    expect(entries.find((entry) => entry.id === "openai")?.envVarName).toBe("OPENAI_API_KEY");
    expect(entries.find((entry) => entry.id === "anthropic")?.envVarName).toBe("ANTHROPIC_API_KEY");
    expect(entries.find((entry) => entry.id === "openai")?.modelCount).toBeGreaterThan(0);
  });
});

describe("literal credentials", () => {
  it("does not expand dollars, returns independent copies, serializes modifications", async () => {
    const credentials = literalCredentials();
    await credentials.modify("openai", async () => ({ type: "api_key", key: "$OPENAI_API_KEY" }));
    const value = await credentials.read("openai");
    expect(value).toEqual({ type: "api_key", key: "$OPENAI_API_KEY" });
    if (value?.type === "api_key") value.key = "changed";
    expect(await credentials.read("openai")).toEqual({ type: "api_key", key: "$OPENAI_API_KEY" });
    await Promise.all([
      credentials.modify("openai", async () => ({ type: "api_key", key: "first" })),
      credentials.modify("openai", async (current) => {
        expect(current).toEqual({ type: "api_key", key: "first" });
        return { type: "api_key", key: "second" };
      }),
    ]);
    expect(await credentials.list()).toEqual([{ providerId: "openai", type: "api_key" }]);
    await credentials.delete("openai");
    expect(await credentials.read("openai")).toBeUndefined();
  });
  it("rejects dangerous values without echoing them", async () => {
    for (const key of ["!never-execute-this", " key", "key\n"]) {
      await expect(
        literalCredentials().modify("openai", async () => ({ type: "api_key", key })),
      ).rejects.toThrow("Unsafe secret value");
    }
  });
});

describe("agent errors", () => {
  it.each([
    [{ status: 401 }, "auth_failed"],
    [{ statusCode: 403 }, "auth_failed"],
    [new Error("401 bad key"), "auth_failed"],
    [{ status: 429 }, "rate_limited"],
    [new Error("rate limit exceeded"), "rate_limited"],
    [{ code: "ECONNREFUSED" }, "network"],
    [{ code: "ENOTFOUND" }, "network"],
    [new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }), "network"],
    [{ name: "TimeoutError" }, "network"],
    [{ name: "AbortError" }, "aborted"],
    ["Request aborted", "aborted"],
    [{ status: 503 }, "provider_overloaded"],
    ["model not found", "provider_rejected"],
    ["opaque diagnostic", "internal"],
    [undefined, "internal"],
    [new AgentError("no_model"), "no_model"],
    [new AgentError("provider_error"), "provider_error"],
    [new Error("No API key found for the selected model"), "auth_failed"],
  ] as const)("maps %j to %s", (error, code) => {
    expect(mapAgentError(error)).toBe(code);
  });
  it("handles nested errors and cyclic causes", () => {
    expect(mapAgentError({ cause: { status: 403 } })).toBe("auth_failed");
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(mapAgentError(error)).toBe("internal");
  });
});
