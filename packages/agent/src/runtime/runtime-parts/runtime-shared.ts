import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Api, ApiKeyAuth, Model } from "@earendil-works/pi-ai";
import { CustomProviderSchema, type ModelInfo } from "@pibot/protocol-base";
import {
  assertSupportedCredential,
  assertSupportedHeaders,
} from "../../auth/claude-subscription.ts";
import { AgentError } from "../../core/errors.ts";
import type { OpenSessionOptions } from "../../core/types.ts";
import { modelThinkingLevels } from "../../models/custom-models.ts";
import { resolveSessionFile } from "../../session/session-files.ts";

export const customConfigSchema = CustomProviderSchema.omit({ apiKey: true });

export function literalAuth(
  enabled: boolean,
  hasKey: () => boolean,
  keyless = false,
  headers?: Record<string, string>,
): ApiKeyAuth {
  return {
    name: "Pi Bot credential",
    async check({ signal }) {
      signal.throwIfAborted();
      return enabled && (keyless || hasKey()) ? { type: "api_key", source: "Pi Bot" } : undefined;
    },
    async resolve({ credential, signal }) {
      signal.throwIfAborted();
      if (!enabled) return undefined;
      assertSupportedCredential(credential?.key);
      assertSupportedHeaders(headers);
      if (credential?.key) return { auth: { apiKey: credential.key, headers }, source: "Pi Bot" };
      // pi's HTTP clients require a nonempty apiKey even for Ollama. Header nulls suppress
      // the synthetic token on OpenAI/Anthropic wire requests; user headers take priority.
      return keyless
        ? {
            auth: {
              apiKey: "pibot-keyless",
              headers: { authorization: null, "x-api-key": null, ...headers },
            },
            source: "Pi Bot keyless endpoint",
          }
        : undefined;
    },
  };
}

export function modelInfo(model: Model<Api>): ModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    input: [...model.input],
    reasoning: model.reasoning,
    maxTokens: model.maxTokens,
    thinkingLevels: modelThinkingLevels(model),
    cost: {
      input: model.cost.input < 0 ? null : model.cost.input,
      output: model.cost.output < 0 ? null : model.cost.output,
      cacheRead: model.cost.cacheRead < 0 ? null : model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite < 0 ? null : model.cost.cacheWrite,
    },
  };
}

export function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Returns the absolute session file to open, if the caller named one. */
export async function sessionPaths(
  dataDir: string,
  opts: Pick<
    OpenSessionOptions,
    "botId" | "homeDir" | "sessionDir" | "sessionFile" | "thinkingLevel" | "systemPrompt"
  >,
): Promise<string | undefined> {
  if (!opts.botId || opts.botId === "." || opts.botId === ".." || /[/\\]/.test(opts.botId))
    throw new AgentError("internal");
  const botDir = join(dataDir, "bots", opts.botId);
  if (
    resolve(opts.homeDir) !== join(botDir, "home") ||
    resolve(opts.sessionDir) !== join(botDir, "sessions")
  )
    throw new AgentError("internal");
  for (const path of [
    dataDir,
    join(dataDir, "bots"),
    botDir,
    opts.homeDir,
    opts.sessionDir,
    join(dataDir, "pi"),
  ]) {
    await mkdir(path, { recursive: true });
    if (!inside(await realpath(dataDir), await realpath(path))) throw new AgentError("internal");
  }
  if (!opts.sessionFile) return undefined;
  const file = resolveSessionFile(dataDir, opts.sessionFile);
  if (dirname(resolve(file)) !== resolve(opts.sessionDir))
    // An absolute row from an older data-directory location is a recoverable user situation
    // (start a new topic), not a bug; the containment rule itself is unchanged.
    throw new AgentError(isAbsolute(opts.sessionFile) ? "session_unavailable" : "internal");
  // pi creates JSONL lazily. A remembered filename may legitimately not exist after abort.
  const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing && dirname(await realpath(file)) !== (await realpath(opts.sessionDir)))
    throw new AgentError("internal");
  return file;
}
