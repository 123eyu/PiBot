import type { McpServer } from "@agentclientprotocol/sdk";
import { groupRuntime } from "./runtime-group.ts";
import type { AcpFolderStaging, AcpRpcPort } from "./runtime-rpc.ts";
import type { AcpMcpPreview, AcpRuntimePort } from "./types.ts";

function mcpJson(servers: McpServer[]) {
  return JSON.stringify({
    mcpServers: Object.fromEntries(
      servers.map((server) => [
        server.name,
        "command" in server
          ? {
              type: "stdio",
              command: server.command,
              args: server.args,
              env: Object.fromEntries(server.env.map((entry) => [entry.name, entry.value])),
            }
          : {
              type: server.type,
              url: server.url,
              headers: Object.fromEntries(server.headers.map((entry) => [entry.name, entry.value])),
            },
      ]),
    ),
  });
}

/** Adapts only the RPCs used by ACP; the caller retains brain and execution ownership. */
export function createAcpRuntime(options: {
  rpc: AcpRpcPort;
  folders: AcpFolderStaging;
  ready(signal: AbortSignal): Promise<void>;
  timeoutMs: number;
}): AcpRuntimePort {
  const bounded = (signal: AbortSignal) =>
    AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]);
  /** Registers the client's folders the same way for a new topic and a rebound one. */
  const pickFolders = async (
    input: { botId: string; cwd: string; additionalDirectories: string[] },
    signal: AbortSignal,
  ) => {
    const folders: string[] = [];
    const paths = new Set<string>();
    for (const path of [input.cwd, ...input.additionalDirectories]) {
      if (paths.has(path)) continue;
      paths.add(path);
      const picked = await options.folders.withPath(
        path,
        () =>
          options.rpc.call(
            "workplaces.pick",
            { botId: input.botId, association: "session" },
            { signal: bounded(signal) },
          ),
        bounded(signal),
      );
      if (!picked.folder) throw new Error("ACP working directory was not registered");
      folders.push(picked.folder.id);
    }
    if (!folders.length) throw new Error("ACP working directory is missing");
    return folders;
  };
  return {
    ...groupRuntime(options),
    ready: options.ready,
    async bots(signal) {
      await options.ready(signal);
      return options.rpc.call("bots.list", {}, { signal: bounded(signal) });
    },
    async settings(signal) {
      await options.ready(signal);
      return options.rpc.call("settings.get", {}, { signal: bounded(signal) });
    },
    async setAutoCheck(topicId, enabled, signal) {
      await options.ready(signal);
      await options.rpc.call(
        "autoCheck.conversation.set",
        { conversationId: topicId, enabled },
        { signal: bounded(signal) },
      );
    },
    async rebindTopic(input, signal) {
      await options.ready(signal);
      const folders = await pickFolders(input, signal);
      await options.rpc.call(
        "topics.workplace.update",
        {
          botId: input.botId,
          topicId: input.topicId,
          selection: { primary: folders[0] as string, readonly: folders.slice(1) },
          acpSession: true,
        },
        { signal: bounded(signal) },
      );
    },
    async createTopic(input, signal) {
      await options.ready(signal);
      const folders = await pickFolders(input, signal);
      const primary = folders[0];
      if (!primary) throw new Error("ACP working directory is missing");
      const topic = await options.rpc.call(
        "topics.create",
        { botId: input.botId },
        { signal: bounded(signal) },
      );
      try {
        await options.rpc.call(
          "topics.workplace.update",
          {
            botId: input.botId,
            topicId: topic.id,
            selection: { primary, readonly: folders.slice(1) },
            acpSession: true,
          },
          { signal: bounded(signal) },
        );
        // After binding: YOLO is the same per-topic switch the chat header shows, audited by the
        // brain; danger cards still ask (mustAskNow). A failure archives the
        // topic below rather than leaving one that asks for every step.
        if (input.yolo)
          await options.rpc.call(
            "conversations.yolo.set",
            { conversationId: topic.id, enabled: true },
            { signal: bounded(signal) },
          );
      } catch (error) {
        // Preserve the binding / YOLO error; a half-set-up topic has no dispatched run to recover here.
        await options.rpc
          .call(
            "topics.archive",
            { botId: input.botId, topicId: topic.id },
            { signal: AbortSignal.timeout(5_000) },
          )
          .catch(() => undefined);
        throw error;
      }
      return { topicId: topic.id };
    },
    async models(signal) {
      await options.ready(signal);
      const models = await options.rpc.call(
        "models.list",
        { availableOnly: true },
        { signal: bounded(signal) },
      );
      return models.map(({ provider, id, name, reasoning, thinkingLevels }) => ({
        provider,
        id,
        name,
        thinkingLevels: reasoning ? (thinkingLevels ?? ["off", "low", "medium", "high"]) : ["off"],
      }));
    },
    async providers(signal) {
      await options.ready(signal);
      const providers = await options.rpc.call("providers.list", {}, { signal: bounded(signal) });
      // Only the display name leaves; base URLs and auth state stay in the brain.
      return providers.map(({ id, name }) => ({ id, name }));
    },
    async setBotModel(input, signal) {
      await options.ready(signal);
      await options.rpc.call(
        "bots.update",
        { botId: input.botId, modelProvider: input.provider, modelId: input.id },
        { signal: bounded(signal) },
      );
    },
    async setBotThinking(input, signal) {
      await options.ready(signal);
      await options.rpc.call(
        "bots.update",
        { botId: input.botId, thinkingLevel: input.thinkingLevel },
        { signal: bounded(signal) },
      );
    },
    async setDefaultModel(input, signal) {
      await options.ready(signal);
      // The same write as Settings › Models: a new default keeps the person's saved preference.
      const current = await options.rpc.call("settings.get", {}, { signal: bounded(signal) });
      await options.rpc.call(
        "settings.set",
        {
          defaultModel: {
            provider: input.provider,
            id: input.id,
            thinkingLevel: input.thinkingLevel,
            ...(current.defaultModel?.thinkingPreference !== undefined
              ? { thinkingPreference: current.defaultModel.thinkingPreference }
              : {}),
          },
        },
        { signal: bounded(signal) },
      );
    },
    async sendPrompt(input, signal) {
      await options.ready(signal);
      // Ownership transfers synchronously at call dispatch. Do not pass the turn signal after
      // this point: even if ACP cancels, we must receive the run id and abort that exact run.
      signal.throwIfAborted();
      return options.rpc.call("chat.send", {
        botId: input.botId,
        topicId: input.topicId,
        text: input.text,
      });
    },
    async archiveTopic(input, signal) {
      await options.rpc.call("topics.archive", input, { signal: bounded(signal) });
    },
    async attachTopic(input, signal) {
      await options.ready(signal);
      // The brain owns the checks (Bot, kind, archive state, folder match); this only forwards.
      return options.rpc.call("topics.acp.attach", input, { signal: bounded(signal) });
    },
    async abort(runId, signal) {
      await options.rpc.call("chat.abort", { runId }, { signal: bounded(signal) });
    },
    async resolveApproval(input, signal) {
      await options.rpc.call(
        "approvals.resolve",
        {
          id: input.id,
          decision: input.decision,
          remember: false,
          ...(input.allowSession ? { allowSession: true } : {}),
        },
        { signal: bounded(signal) },
      );
    },
    async previewMcp(servers, signal) {
      const preview = await options.rpc.call(
        "plugins.previewImport",
        { source: { kind: "json", text: mcpJson(servers) } },
        { signal: bounded(signal) },
      );
      return {
        previewId: preview.previewId,
        digest: preview.digest,
        name: preview.manifest.name,
        servers: preview.manifest.servers.map((server) => ({
          id: server.id,
          transport: server.transport,
          ...(server.transport === "stdio" ? { command: server.command, args: server.args } : {}),
          networkDomains: server.networkDomains,
          secretNames: server.auth.secretNames,
        })),
      };
    },
    async importMcp(preview: AcpMcpPreview, signal) {
      await options.rpc.call(
        "plugins.import",
        {
          previewId: preview.previewId,
          enable: true,
          expectedDigest: preview.digest,
          config: {},
          networkDomains: Object.fromEntries(
            preview.servers.map((server) => [server.id, server.networkDomains]),
          ),
        },
        { signal: bounded(signal) },
      );
    },
    async cancelMcpPreview(previewId, signal) {
      await options.rpc.call("plugins.cancelPreview", { previewId }, { signal: bounded(signal) });
    },
    onEvent(listener) {
      const cleanups: Array<() => void> = [];
      try {
        cleanups.push(
          options.rpc.on("chat.delta", (payload) => listener({ method: "chat.delta", payload })),
        );
        cleanups.push(
          options.rpc.on("chat.tool", (payload) => listener({ method: "chat.tool", payload })),
        );
        cleanups.push(
          options.rpc.on("approval.requested", (payload) =>
            listener({ method: "approval.requested", payload }),
          ),
        );
        cleanups.push(
          options.rpc.on("approval.resolved", (payload) =>
            listener({ method: "approval.resolved", payload }),
          ),
        );
        cleanups.push(
          options.rpc.on("chat.done", (payload) => listener({ method: "chat.done", payload })),
        );
        cleanups.push(
          options.rpc.on("chat.error", (payload) => listener({ method: "chat.error", payload })),
        );
      } catch (error) {
        for (const cleanup of cleanups) cleanup();
        throw error;
      }
      return () => {
        for (const cleanup of cleanups) cleanup();
      };
    },
  };
}
