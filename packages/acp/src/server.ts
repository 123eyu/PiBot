/*
 * ACP v1 translator. The SDK owns framing; Pi Bot's zod schemas (see `schemas.ts`) remain the
 * input boundary. This file owns the connection: sessions, modes, the model option and the
 * lifetime; one turn's streaming lives in `prompt-turn.ts` and the permission card in
 * `approval.ts`.
 */
import { randomUUID } from "node:crypto";
import {
  type AgentApp,
  agent,
  type McpServer,
  methods,
  PROTOCOL_VERSION,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { acpCancelled, acpFailure } from "./errors.ts";
import { language, mcpScope } from "./messages.ts";
import {
  DEFAULT_MODEL_CONFIG_ID,
  defaultThinking,
  extraConfig,
  MODEL_CONFIG_ID,
  modelConfig,
  modelOptions,
  THINKING_CONFIG_ID,
} from "./model-config.ts";
import { runPromptTurn } from "./prompt-turn.ts";
import { waitForResponse } from "./request-wait.ts";
import {
  deleteSession,
  loadSession,
  newSession,
  permissionOutcome,
  prompt,
  setConfigOption,
} from "./schemas.ts";
import {
  archiveTargetTopic,
  createTargetTopic,
  modeTarget,
  rebindTargetTopic,
  requestedTarget,
  sessionTarget,
  targetModeId,
  validateTarget,
} from "./session-target.ts";
import type { AcpAgentOptions, SessionState } from "./state.ts";
import type { AcpClientPort, AcpTarget } from "./types.ts";

export type { AcpAgentOptions } from "./state.ts";

/** ACP v1 translator. The SDK owns framing; Pi Bot's zod schemas above remain the input boundary. */
export function createAcpAgent(options: AcpAgentOptions): {
  app: AgentApp;
  dispose(): Promise<void>;
} {
  const sessions = new Map<string, SessionState>();
  let clientPort: AcpClientPort | undefined;
  let locale: "zh" | "en" = "en";
  let bots: Awaited<ReturnType<AcpAgentOptions["runtime"]["bots"]>> = [];
  let groups: Awaited<ReturnType<NonNullable<AcpAgentOptions["runtime"]["groups"]>>> = [];
  let groupAvailable = false;
  const refreshTargets = async (signal: AbortSignal) => {
    bots = (await options.runtime.bots(signal)).filter((bot) => !bot.archivedAt);
    try {
      groups = options.runtime.groups ? await options.runtime.groups(signal) : [];
      groupAvailable = !!options.runtime.groups;
    } catch (error) {
      // A newer ACP frontend can still serve Bot sessions against a Bot-only owner.
      if ((error as { code?: unknown }).code !== -32601) throw error;
      groups = [];
      groupAvailable = false;
    }
  };
  let closing = false;
  const lifetime = new AbortController();
  const prompts = new Set<Promise<void>>();
  const sessionRequests = new Set<Promise<void>>();
  // A background with no GUI attached refuses interactive work with -32001, and the brain refuses
  // plenty of other things by business code; ACP's generic handler would report all of them as
  // "Internal error", which reads like a bug and tells a caller nothing it can act on.
  const interactive = <T>(promise: Promise<T>): Promise<T> =>
    promise.catch((error) => {
      throw acpFailure(error);
    });
  const sessionRequest = async <T>(
    signal: AbortSignal,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (closing) throw new Error("ACP agent is closing");
    let release!: () => void;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    sessionRequests.add(drained);
    try {
      const bounded = AbortSignal.any([
        signal,
        lifetime.signal,
        AbortSignal.timeout(options.runTimeoutMs ?? 600_000),
      ]);
      // Cancellation covers the whole preparation: a client that already cancelled must not get a
      // session, folders or an import preview as the side effect of a late answer.
      if (bounded.aborted) throw acpCancelled();
      return await interactive(action(bounded));
    } finally {
      sessionRequests.delete(drained);
      release();
    }
  };
  let disposing: Promise<void> | undefined;
  let creatingSessions = 0;
  let pendingPermissions = 0;
  let permissionBytes = 0;
  const permissionBudget = options.permissionBudget ?? { requests: 16, bytes: 1024 * 1024 };
  const permissionCapacity = () => {
    closing = true;
    lifetime.abort();
    // The transport owner drains runs before closing SDK, which settles its pending responses.
    options.onPermissionCapacity?.();
    throw new Error("ACP permission capacity exceeded");
  };

  const session = (id: string) => {
    if (closing) throw new Error("ACP agent is closing");
    const value = sessions.get(id);
    if (!value) throw new Error("Unknown ACP session");
    return value;
  };
  const modes = (currentModeId: string) => ({
    currentModeId,
    availableModes: bots
      .filter((bot) => !bot.archivedAt)
      .map((bot) => ({
        id: bot.id,
        name: bot.name,
        description: bot.isMain ? "Pi Bot" : undefined,
      }))
      .concat(
        groups.map((group) => ({
          id: `group:${group.id}`,
          name: group.name,
          description: "Pi Bot group",
          _meta: {
            "pibot/target": {
              kind: "group",
              groupId: group.id,
              coordinatorBotId: group.coordinatorBotId,
            },
          },
        })),
      ),
  });
  /** The session Bot's "model" option; a listing failure only hides the picker. */
  const configOptions = async (selection: string | AcpTarget, signal: AbortSignal) => {
    if (typeof selection !== "string" && selection.kind === "group") return [];
    const botId = typeof selection === "string" ? selection : selection.botId;
    const bot = bots.find((candidate) => candidate.id === botId);
    if (!bot) return [];
    try {
      const [offered, settings] = await Promise.all([
        modelOptions(options.runtime, signal),
        options.runtime.settings(signal),
      ]);
      return [
        ...modelConfig(bot, offered),
        ...extraConfig(bot, offered, settings.defaultModel, {
          thinking: !!options.runtime.setBotThinking,
          defaultModel: !!options.runtime.setDefaultModel,
        }),
      ];
    } catch (error) {
      if (signal.aborted) throw error;
      return [];
    }
  };
  const notify = async (sessionId: string, update: SessionUpdate, signal: AbortSignal) => {
    if (!clientPort) throw new Error("ACP client is not initialized");
    const outputSignal = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(10_000)]);
    outputSignal.throwIfAborted();
    // A blocked SDK writer cannot be drained by cancelling a turn. Observe its late settlement,
    // but stop waiting locally so execution cleanup can run before the protocol is closed.
    await waitForResponse(clientPort.notify({ sessionId, update }), outputSignal);
  };

  const remember = (state: SessionState) =>
    options.sessionMemory?.remember({
      id: state.id,
      botId: state.botId,
      target: sessionTarget(state),
      roots: state.roots,
      topics: [...state.topics],
      yolo: state.yolo,
      ...(state.attached ? { attached: true } : {}),
      ...(state.groupRun ? { groupRun: state.groupRun } : {}),
    });
  const settleGroup = async (state: SessionState, signal: AbortSignal) => {
    if (!state.groupRun) return;
    if (!options.runtime.cancelGroup) throw new Error("group_cleanup_unconfirmed");
    const receipt = state.groupRun;
    const result = await options.runtime.cancelGroup(receipt, signal);
    if (
      result.runId !== receipt.runId ||
      result.assistantMessageId !== receipt.assistantMessageId ||
      result.groupId !== receipt.groupId ||
      result.topicId !== receipt.topicId ||
      result.cycleId !== receipt.cycleId ||
      result.budgetRootRunId !== receipt.budgetRootRunId ||
      !result.drained
    )
      throw new Error("group_cleanup_unconfirmed");
    delete state.groupRun;
    delete state.activeRun;
    remember(state);
  };

  const app = agent({ name: "Pi Bot" });
  app.onRequest(methods.agent.initialize, async ({ params, signal, client }) => {
    if (closing) throw new Error("ACP agent is closing");
    await interactive(options.runtime.ready(signal));
    const settings = await interactive(options.runtime.settings(signal));
    locale = language(settings.language);
    await interactive(refreshTargets(signal));
    if (!bots.length) throw new Error("Pi Bot has no active Bot");
    const caps = params.clientCapabilities;
    clientPort = {
      request: (method, value, requestSignal) => {
        if (method !== methods.client.session.requestPermission)
          return client.request(method, value, { cancellationSignal: requestSignal });
        const permissionSignal = AbortSignal.any([
          ...(requestSignal ? [requestSignal] : []),
          lifetime.signal,
          AbortSignal.timeout(options.runTimeoutMs ?? 600_000),
        ]);
        permissionSignal.throwIfAborted();
        const bytes = Buffer.byteLength(JSON.stringify(value));
        if (
          pendingPermissions >= permissionBudget.requests ||
          permissionBytes + bytes > permissionBudget.bytes
        )
          return permissionCapacity();
        pendingPermissions++;
        permissionBytes += bytes;
        let response: Promise<unknown>;
        try {
          response = client.request(method, value, { cancellationSignal: permissionSignal });
        } catch (error) {
          pendingPermissions--;
          permissionBytes -= bytes;
          throw error;
        }
        const settled = () => {
          // Only the original SDK promise settles this reservation, never local cancellation.
          pendingPermissions--;
          permissionBytes -= bytes;
        };
        void response.then(settled, settled);
        void response.then(
          () => {
            if (permissionSignal.aborted) options.debug?.("permission_response_ignored");
          },
          () => {
            // The bounded wait handles errors; late rejections cannot authorize anything.
            if (permissionSignal.aborted) options.debug?.("permission_response_ignored");
          },
        );
        return waitForResponse(response, permissionSignal);
      },
      notify: (value) => client.notify(methods.client.session.update, value),
    };
    options.execution?.bindClient(clientPort, {
      read: caps?.fs?.readTextFile === true,
      write: caps?.fs?.writeTextFile === true,
      terminal: caps?.terminal === true,
    });
    return {
      protocolVersion: Math.min(params.protocolVersion, PROTOCOL_VERSION),
      agentInfo: { name: "Pi Bot", version: options.version },
      _meta: {
        "pibot/groups":
          groupAvailable &&
          [
            options.runtime.groups,
            options.runtime.group,
            options.runtime.createGroupTopic,
            options.runtime.attachGroupTopic,
            options.runtime.rebindGroupTopic,
            options.runtime.archiveGroupTopic,
            options.runtime.sendGroupPrompt,
            options.runtime.groupSnapshot,
            options.runtime.cancelGroup,
          ].every((method) => typeof method === "function"),
      },
      agentCapabilities: {
        promptCapabilities: {},
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: {
          additionalDirectories: {},
          ...(options.sessionMemory ? { delete: {} } : {}),
        },
        ...(options.sessionMemory ? { loadSession: true } : {}),
      },
    };
  });

  app.onRequest(methods.agent.session.new, ({ params, signal }) =>
    sessionRequest(signal, async (signal) => {
      if (closing || !clientPort) throw new Error("ACP client is not available");
      const input = newSession.parse(params);
      if (options.maxSessions && sessions.size + creatingSessions >= options.maxSessions)
        throw new Error("ACP session capacity exceeded");
      creatingSessions++;
      let creationReserved = true;
      try {
        await refreshTargets(signal);
        const settings = await options.runtime.settings(signal);
        if (input._meta?.["pibot/group"] && !groupAvailable)
          throw new Error("acp_group_unsupported");
        const target = requestedTarget(input._meta, bots, groups) ?? {
          kind: "bot" as const,
          botId:
            (
              bots.find((bot) => bot.id === settings.acpDefaultBotId) ??
              bots.find((bot) => bot.isMain) ??
              bots[0]
            )?.id ?? "",
        };
        const botId = await validateTarget(options.runtime, target, signal);
        const modeId = targetModeId(target);
        const id = randomUUID();
        const roots = [input.cwd, ...(input.additionalDirectories ?? [])];
        // An explicit topic id continues that topic instead of opening one. It is the person's
        // topic, so this session never applies YOLO to it and never archives it on failure.
        const attachedTopic = input._meta?.["pibot/topic"];
        if (attachedTopic && !input._meta?.["pibot/bot"] && !input._meta?.["pibot/group"])
          throw new Error("ACP topic attach needs an explicit target");
        const yolo = attachedTopic ? false : input._meta?.["pibot/yolo"] === true;
        const topic = await createTargetTopic(
          options.runtime,
          target,
          roots,
          yolo,
          signal,
          attachedTopic,
        );
        const autoCheck = input._meta?.["pibot/autocheck"] !== false;
        const state: SessionState = {
          id,
          botId,
          target,
          ...(attachedTopic ? { attached: true } : {}),
          roots,
          topics: new Map([[modeId, topic.topicId]]),
          yolo,
          autoCheck,
        };
        sessions.set(id, state);
        options.sessionMemory?.claim(id);
        // Publishing the session and releasing its creation slot are synchronous.
        creatingSessions--;
        creationReserved = false;
        options.execution?.registerSession(id, roots);

        try {
          if (!autoCheck) await options.runtime.setAutoCheck?.(topic.topicId, false, signal);
          if (input.mcpServers.length) {
            const preview = await options.runtime.previewMcp(
              input.mcpServers as McpServer[],
              signal,
            );
            try {
              if (
                options.execution?.location.platform === "win32" &&
                preview.servers.some((server) => server.transport === "stdio")
              )
                throw new Error(
                  "ACP stdio MCP import is unavailable on Windows before persistent unisolated-command consent",
                );
              const scope = mcpScope(preview, locale);
              const outcome = permissionOutcome.parse(
                await clientPort.request(
                  methods.client.session.requestPermission,
                  {
                    sessionId: id,
                    toolCall: {
                      toolCallId: `mcp-import:${preview.previewId}`,
                      kind: "other",
                      status: "pending",
                      title: scope.title,
                      name: "plugin_import",
                      content: [
                        { type: "content", content: { type: "text", text: scope.details } },
                      ],
                    },
                    options: [
                      {
                        optionId: "import",
                        name: locale === "zh" ? "导入" : "Import",
                        kind: "allow_once",
                      },
                      {
                        optionId: "skip",
                        name: locale === "zh" ? "不导入" : "Skip",
                        kind: "reject_once",
                      },
                    ],
                  },
                  signal,
                ),
              );
              if (outcome.outcome.outcome === "selected" && outcome.outcome.optionId === "import")
                await options.runtime.importMcp(preview, signal);
              else await options.runtime.cancelMcpPreview(preview.previewId, signal);
            } catch (error) {
              await options.runtime
                .cancelMcpPreview(preview.previewId, signal)
                .catch(() => undefined);
              throw error;
            }
          }
          options.sessionMemory?.remember({
            id,
            botId,
            target,
            roots,
            topics: [...state.topics],
            yolo,
            ...(attachedTopic ? { attached: true } : {}),
          });
          return {
            sessionId: id,
            modes: modes(modeId),
            configOptions: await configOptions(target, signal),
            _meta: { "pibot/target": target },
          };
        } catch (error) {
          sessions.delete(id);
          options.sessionMemory?.release(id);
          options.execution?.unregisterSession(id);
          // An attached topic belongs to the person: a failed session must leave it alone.
          if (!attachedTopic)
            await archiveTargetTopic(
              options.runtime,
              target,
              topic.topicId,
              AbortSignal.timeout(5_000),
            ).catch(() => undefined);
          throw error;
        }
      } finally {
        if (creationReserved) creatingSessions--;
      }
    }),
  );

  // Continue an ACP-created session on a new connection; no MCP import and no history replay
  // (the topic keeps its history in Pi Bot itself). Other folders rebind the session's topics:
  // maintainers 2026-11-04 keeps one topic per milestone while each task works in its own worktree.
  // Trust is the same as session/new, which registers whatever folders the client names.
  app.onRequest(methods.agent.session.load, ({ params, signal }) =>
    sessionRequest(signal, async (signal) => {
      if (closing || !clientPort || !options.sessionMemory)
        throw new Error("ACP session load is not available");
      const input = loadSession.parse(params);
      if (input.mcpServers.length) throw new Error("ACP session load does not import MCP servers");
      const record = options.sessionMemory.recall(input.sessionId);
      const roots = [input.cwd, ...(input.additionalDirectories ?? [])];
      if (!record) throw new Error("Unknown ACP session");
      if (sessions.has(record.id) || !options.sessionMemory.claim(record.id))
        throw new Error("ACP session is already open");
      // A load that fails after the claim must not leave the topic locked for every later client.
      // Once this call published the session, that state is this call's to withdraw too: an error
      // answer with a registered, claimed session would leave the next client "already open"
      // against a connection that already failed.
      let published: SessionState | undefined;
      try {
        const moved =
          record.roots.length !== roots.length ||
          record.roots.some((root, index) => root !== roots[index]);
        if (options.maxSessions && sessions.size + creatingSessions >= options.maxSessions)
          throw new Error("ACP session capacity exceeded");
        await refreshTargets(signal);
        const target = sessionTarget(record);
        const botId = await validateTarget(options.runtime, target, signal);
        const modeId = targetModeId(target);
        const validModes = new Set([
          ...bots.map((bot) => bot.id),
          ...groups.map((group) => `group:${group.id}`),
        ]);
        const topics = new Map(record.topics.filter(([key]) => validModes.has(key)));
        if (moved && record.groupRun) throw new Error("group_cleanup_unconfirmed");
        if (moved) {
          // Only the current Bot's topic moves with the session. Other Bots' topics are dropped
          // (switching mode opens a fresh one in the new folders): sessions made before
          // _meta pibot/bot kept an empty default-Bot topic, and once the owner removed it every
          // later load failed on "Unknown topic" (2026-11-05).
          const current = topics.get(modeId);
          if (!current) throw new Error("Unknown ACP session");
          await rebindTargetTopic(options.runtime, target, current, roots, signal);
          for (const key of [...topics.keys()]) if (key !== modeId) topics.delete(key);
          options.sessionMemory.remember({ ...record, target, botId, roots, topics: [...topics] });
        }
        const currentTopic = topics.get(modeId);
        if (!currentTopic) throw new Error("Unknown ACP session");
        if (!moved && !record.groupRun)
          await createTargetTopic(options.runtime, target, roots, false, signal, currentTopic);
        const autoCheck = input._meta?.["pibot/autocheck"] !== false;
        // Every load, either way: the brain may still hold an earlier "off" for these topics.
        for (const topicId of topics.values())
          await options.runtime.setAutoCheck?.(topicId, autoCheck, signal);
        const state: SessionState = {
          id: record.id,
          botId,
          target,
          ...(record.attached ? { attached: true } : {}),
          ...(record.groupRun ? { groupRun: record.groupRun } : {}),
          roots,
          topics,
          yolo: record.yolo,
          autoCheck,
        };
        sessions.set(state.id, state);
        options.execution?.registerSession(state.id, roots);
        published = state;
        return {
          modes: modes(modeId),
          configOptions: await configOptions(target, signal),
          _meta: { "pibot/target": target },
        };
      } catch (error) {
        // Only our own state: another connection may already hold this id after a retry.
        if (published && sessions.get(record.id) === published) {
          sessions.delete(record.id);
          options.execution?.unregisterSession(record.id);
        }
        options.sessionMemory.release(record.id);
        throw error;
      }
    }),
  );

  // Maintainers 2026-11-05: pibot-dev tidies the topics of finished task sessions. Deleting archives the
  // session's topics in Pi Bot (they stay under 已归档; nothing is erased) and forgets the record.
  // Only an ACP-created session that no connection holds; repeating it is harmless.
  app.onRequest(methods.agent.session.delete, ({ params, signal }) =>
    sessionRequest(signal, async (signal) => {
      if (closing || !options.sessionMemory) throw new Error("ACP session delete is not available");
      const { sessionId } = deleteSession.parse(params);
      const record = options.sessionMemory.recall(sessionId);
      if (!record) return {};
      if (sessions.has(sessionId) || !options.sessionMemory.claim(sessionId))
        throw new Error("ACP session is open");
      try {
        if (record.groupRun)
          await settleGroup({ ...record, topics: new Map(record.topics), autoCheck: true }, signal);
        // A topic the owner already removed or archived is the outcome we want anyway. A topic the
        // session attached to is the person's, not the task's: deleting the session leaves it.
        if (!record.attached)
          for (const [modeId, topicId] of record.topics)
            await archiveTargetTopic(options.runtime, modeTarget(modeId), topicId, signal);
        options.sessionMemory.forget(sessionId);
      } finally {
        options.sessionMemory.release(sessionId);
      }
      return {};
    }),
  );

  app.onRequest(methods.agent.session.setMode, ({ params, signal }) =>
    sessionRequest(signal, async (signal) => {
      const state = session(params.sessionId);
      if (state.busy) throw new Error("ACP session is busy");
      if (state.groupRun) throw new Error("group_cleanup_unconfirmed");
      await refreshTargets(signal);
      const target = modeTarget(params.modeId);
      const botId = await validateTarget(options.runtime, target, signal);
      const modeId = targetModeId(target);
      if (state.busy) throw new Error("ACP session is busy");
      if (state.groupRun) throw new Error("group_cleanup_unconfirmed");
      state.busy = true;
      try {
        let topicId = state.topics.get(modeId);
        if (!topicId) {
          const topic = await createTargetTopic(
            options.runtime,
            target,
            state.roots,
            state.yolo,
            signal,
          );
          topicId = topic.topicId;
          try {
            if (!state.autoCheck) await options.runtime.setAutoCheck?.(topicId, false, signal);
            signal.throwIfAborted();
          } catch (error) {
            await archiveTargetTopic(options.runtime, target, topicId, AbortSignal.timeout(5_000));
            throw error;
          }
          state.topics.set(modeId, topicId);
        } else
          await createTargetTopic(options.runtime, target, state.roots, false, signal, topicId);
        state.botId = botId;
        state.target = target;
        delete state.groupRun;
        options.sessionMemory?.remember({
          id: state.id,
          botId: state.botId,
          target,
          ...(state.attached ? { attached: true } : {}),
          roots: state.roots,
          topics: [...state.topics],
          yolo: state.yolo,
        });
        await notify(
          state.id,
          { sessionUpdate: "current_mode_update", currentModeId: modeId },
          signal,
        );
        // Each Bot has its own model, so the picker follows the mode.
        await notify(
          state.id,
          {
            sessionUpdate: "config_option_update",
            configOptions: await configOptions(target, signal),
          },
          signal,
        );
        return {};
      } finally {
        state.busy = false;
      }
    }),
  );

  app.onRequest(methods.agent.session.setConfigOption, ({ params, signal }) =>
    sessionRequest(signal, async (signal) => {
      const input = setConfigOption.parse(params);
      const state = session(input.sessionId);
      if (sessionTarget(state).kind === "group") throw new Error("acp_group_model_unsupported");
      if (
        input.configId !== MODEL_CONFIG_ID &&
        input.configId !== THINKING_CONFIG_ID &&
        input.configId !== DEFAULT_MODEL_CONFIG_ID
      )
        throw new Error("Unknown ACP config option");
      if (state.busy) throw new Error("ACP session is busy");
      state.busy = true;
      try {
        const offered = await modelOptions(options.runtime, signal);
        if (input.configId === THINKING_CONFIG_ID) {
          // Only a level the list offered for this Bot's model; the brain normalizes again.
          const level = (["off", "low", "medium", "high"] as const).find(
            (candidate) => candidate === input.value,
          );
          if (!level || !options.runtime.setBotThinking)
            throw new Error("Unknown ACP thinking level");
          await options.runtime.setBotThinking(
            { botId: state.botId, thinkingLevel: level },
            signal,
          );
        } else if (input.configId === DEFAULT_MODEL_CONFIG_ID) {
          const choice = offered.find((option) => option.value === input.value);
          if (!choice || !options.runtime.setDefaultModel) throw new Error("Unknown ACP model");
          const settings = await options.runtime.settings(signal);
          await options.runtime.setDefaultModel(
            {
              provider: choice.provider,
              id: choice.id,
              thinkingLevel: defaultThinking(choice, settings.defaultModel?.thinkingLevel),
            },
            signal,
          );
        } else {
          const choice = offered.find((option) => option.value === input.value);
          if (!choice) throw new Error("Unknown ACP model");
          await options.runtime.setBotModel(
            { botId: state.botId, provider: choice.provider, id: choice.id },
            signal,
          );
        }
        bots = (await options.runtime.bots(signal)).filter((bot) => !bot.archivedAt);
        return { configOptions: await configOptions(state.botId, signal) };
      } finally {
        state.busy = false;
      }
    }),
  );

  app.onRequest(methods.agent.session.prompt, async ({ params, signal }) => {
    try {
      // A prompt the caller already cancelled must not start a run (found in review: the request
      // arrived after its cancellation and the Bot still worked).
      if (signal.aborted) throw acpCancelled();
      const input = prompt.parse(params);
      const state = session(input.sessionId);
      if (state.busy) throw new Error("ACP session is busy");
      if (state.groupRun) throw new Error("group_cleanup_unconfirmed");
      const text = input.prompt
        .map((block) =>
          block.type === "text"
            ? block.text
            : `[${block.name.replace(/[\r\n]/g, " ")}](${block.uri})`,
        )
        .join("\n")
        .trim();
      if (!text) throw new Error("Empty ACP prompt");
      const target = sessionTarget(state);
      const botId = await validateTarget(options.runtime, target, signal);
      if (state.busy) throw new Error("ACP session is busy");
      if (state.groupRun) throw new Error("group_cleanup_unconfirmed");
      state.botId = botId;
      const topicId = state.topics.get(targetModeId(target));
      if (!topicId) throw new Error("ACP session topic is unavailable");
      try {
        return await runPromptTurn({
          options,
          lifetime: lifetime.signal,
          // Getters, not values: the turn reads whatever the connection knows when it needs it.
          locale: () => locale,
          clientPort: () => clientPort,
          prompts,
          interactive,
          notify,
          state,
          topicId,
          text,
          signal,
        });
      } finally {
        remember(state);
      }
    } catch (error) {
      throw acpFailure(error);
    }
  });

  app.onNotification(methods.agent.session.cancel, async ({ params }) => {
    const state = session(params.sessionId);
    if (state.activeAbort) state.activeAbort.abort();
    else if (state.groupRun) {
      state.busy = true;
      try {
        await sessionRequest(lifetime.signal, (signal) => settleGroup(state, signal));
      } finally {
        state.busy = false;
      }
    }
  });

  return {
    app,
    dispose() {
      if (disposing) return disposing;
      closing = true;
      lifetime.abort();
      for (const value of sessions.values()) value.activeAbort?.abort();
      disposing = (async () => {
        // A send already dispatched still owns its eventual run id; let that turn abort it first.
        // Session creation can still own an import preview or a folder mutation after prompt drain.
        await Promise.allSettled([...prompts, ...sessionRequests]);
        for (const value of sessions.values()) {
          if (value.groupRun) {
            try {
              await settleGroup(value, AbortSignal.timeout(35000));
            } catch {
              remember(value);
            }
          }
          options.execution?.unregisterSession(value.id);
          options.sessionMemory?.release(value.id);
        }
        sessions.clear();
      })();
      return disposing;
    },
  };
}
