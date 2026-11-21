import { lstat } from "node:fs/promises";
import { isChatGPTPlanProvider } from "@pibot/protocol-base/provider-catalog";
import { AgentError, mapAgentError } from "../../core/errors.ts";
import type { AgentRuntime } from "../../core/types.ts";
import type { RuntimeContext } from "../runtime.ts";
import { sessionPaths } from "./runtime-shared.ts";

// The phone runtime's adapters (`portable/index.ts`); not imported here, so the brain never loads
// the vendor SDKs the portable entry bundles just to answer this question.
const PORTABLE = new Set(["anthropic-messages", "openai-completions", "openai-responses"]);
const isPortableApi = (
  api: string,
): api is "anthropic-messages" | "openai-completions" | "openai-responses" => PORTABLE.has(api);

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** What a paired phone needs from this runtime; its own key travels separately. */
export function createPortableOperations({
  buildRuntime,
  dataDir,
}: RuntimeContext): Pick<AgentRuntime, "portableModel" | "seedSession"> {
  return {
    async portableModel(providerId, modelId) {
      // Owner rule: a ChatGPT plan never goes to a phone; two copies refreshing one OAuth token
      // would cancel each other. Its models look portable (Responses API), so refuse by id.
      if (isChatGPTPlanProvider(providerId)) return undefined;
      try {
        const { runtime } = await buildRuntime();
        const model = (await runtime.getAvailable(providerId)).find((m) => m.id === modelId);
        if (!model || !isPortableApi(model.api)) return undefined;
        return {
          api: model.api,
          provider: model.provider,
          id: model.id,
          name: model.name,
          baseUrl: model.baseUrl,
          reasoning: model.reasoning,
          input: model.input.filter((v): v is "text" | "image" => v === "text" || v === "image"),
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          // Negative prices mean "unknown" in the catalog; the phone reports cost 0 then.
          cost: {
            input: Math.max(0, model.cost.input),
            output: Math.max(0, model.cost.output),
            cacheRead: Math.max(0, model.cost.cacheRead),
            cacheWrite: Math.max(0, model.cost.cacheWrite),
          },
          hasHeaders: !!model.headers && Object.keys(model.headers).length > 0,
        };
      } catch (error) {
        throw new AgentError(mapAgentError(error));
      }
    },

    async seedSession(request) {
      request.signal.throwIfAborted();
      // Same containment as an ordinary run: inside this Bot's own session directory.
      const file = await sessionPaths(dataDir, {
        botId: request.botId,
        homeDir: request.homeDir,
        sessionDir: request.sessionDir,
        sessionFile: request.sessionFile,
        thinkingLevel: "off",
        systemPrompt: "",
      });
      if (!file) throw new AgentError("internal");
      // A topic the computer already continued keeps its own history; nothing is merged into it,
      // unless the phone's turns joined that topic (they follow its last entry then).
      const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing && (!request.append || !existing.isFile()))
        throw new AgentError("session_unavailable");
      // Through the shared runtime: it sanitizes the environment before the SDK import.
      const { pi } = await buildRuntime();
      request.signal.throwIfAborted();
      // pi writes the file itself once the first user message exists (SessionManager._persist).
      const manager = pi.SessionManager.open(file, request.sessionDir, request.homeDir);
      for (const message of request.messages) {
        if (message.role === "user")
          manager.appendMessage({ role: "user", content: message.text, timestamp: message.at });
        else
          manager.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: message.text }],
            api: request.model.api,
            provider: request.model.provider,
            model: request.model.id,
            usage: {
              input: message.usage?.input ?? 0,
              output: message.usage?.output ?? 0,
              cacheRead: message.usage?.cacheRead ?? 0,
              cacheWrite: message.usage?.cacheWrite ?? 0,
              totalTokens: (message.usage?.input ?? 0) + (message.usage?.output ?? 0),
              cost: zeroCost,
            },
            stopReason: "stop",
            timestamp: message.at,
          });
      }
    },
  };
}
