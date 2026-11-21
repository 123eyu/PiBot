import {
  type createPeer,
  DEFAULT_EXECUTION_LIMITS,
  type Events,
  type Message,
  type Methods,
  type Port,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import { registerBrowser } from "./fixture-browser.ts";

/** Explicit, memory-only development fixture for the chat controls. */
export type ServerPeer = ReturnType<typeof createPeer<typeof Methods, typeof Events>>;
/** The desktop gateway's checks, injected by the dev probe so the app never imports them. */
export interface PhoneGate {
  isPhoneMethod(method: string): boolean;
  restrictPhoneParams(method: string, params: unknown): void;
}
/** Records each request method and applies the phone gate before the handler sees it. */
export function gatePort(port: Port, calls: string[], gate?: PhoneGate, frames?: number[]): Port {
  return {
    post: (message) => {
      // Response sizes, so the files probe can show every reply fits the phone frame cap.
      frames?.push(new TextEncoder().encode(JSON.stringify(message)).length);
      port.post(message);
    },
    dispose: () => port.dispose?.(),
    onMessage(listener) {
      return port.onMessage((raw) => {
        const request = (raw ?? {}) as { id?: unknown; method?: unknown; params?: unknown };
        if (typeof request.method === "string" && request.id !== undefined) {
          calls.push(request.method);
          try {
            if (gate && !gate.isPhoneMethod(request.method))
              throw new RpcError(RpcErrorCodes.methodNotFound, "remote_method_unavailable");
            gate?.restrictPhoneParams(request.method, request.params);
          } catch (error) {
            const rpc =
              error instanceof RpcError
                ? error
                : new RpcError(RpcErrorCodes.invalidRequest, "remote_request_invalid");
            port.post({
              jsonrpc: "2.0",
              id: request.id,
              error: { code: rpc.code, message: rpc.message },
            });
            return;
          }
        }
        listener(raw);
      });
    },
  };
}
export interface ControlIds {
  botId: string;
  topicId: string;
  otherTopicId: string;
  folderId: string;
  checkpointId: string;
  runId: string;
}
export function controlIds(botId: string, topicId: string): ControlIds {
  const id = () => crypto.randomUUID();
  return { botId, topicId, otherTopicId: id(), folderId: id(), checkpointId: id(), runId: id() };
}
/** Survives reconnects of the in-memory link, like the computer's own state would. */
export function controlState(ids: ControlIds) {
  return {
    current: ids.topicId,
    folder: "home",
    mode: "execute" as "execute" | "plan",
    version: 1,
    restored: false,
    yolo: false,
  };
}
export type ControlState = ReturnType<typeof controlState>;
const now = () => new Date().toISOString();
function topic(ids: ControlIds, id: string, title: string, current: string) {
  return {
    id,
    kind: "dm" as const,
    botId: ids.botId,
    title,
    piSessionFile: null,
    createdAt: now(),
    updatedAt: now(),
    messageCount: 1,
    isCurrent: id === current,
  };
}
function registerTopics(server: ServerPeer, ids: ControlIds, state: ControlState) {
  server.handle("topics.list", async () => [
    topic(ids, ids.topicId, "Development topic", state.current),
    topic(ids, ids.otherTopicId, "Second topic", state.current),
  ]);
  server.handle("topics.switch", async ({ topicId }) => {
    state.current = topicId;
    const {
      messageCount: _count,
      isCurrent: _current,
      ...row
    } = topic(ids, topicId, "Switched", topicId);
    return row;
  });
  server.handle("topics.create", async () => {
    state.current = crypto.randomUUID();
    const {
      messageCount: _count,
      isCurrent: _current,
      ...row
    } = topic(ids, state.current, "New", state.current);
    return row;
  });
  const workplace = () => ({
    topicId: state.current,
    folderId: state.folder === "home" ? ("home" as const) : state.folder,
    revision: 1,
    busy: false,
    readonly: [],
    workplace: { home: "/dev/bot-home", folders: [], currentId: "home" as const },
  });
  server.handle("topics.workplace.get", async () => workplace());
  server.handle("topics.workplace.set", async ({ folderId }) => {
    state.folder = folderId ?? "home";
    return workplace();
  });
  server.handle("workplaces.list", async () => ({
    home: "/dev/bot-home",
    folders: [
      { id: ids.folderId, path: "/dev/project", name: "project", association: "user" as const },
    ],
    currentId: "home",
  }));
}
function registerExecution(server: ServerPeer, ids: ControlIds, state: ControlState) {
  const settings = () => ({
    botId: ids.botId,
    conversationId: ids.topicId,
    mode: state.mode,
    limits: DEFAULT_EXECUTION_LIMITS,
    version: state.version,
    updatedAt: null,
  });
  server.handle("execution.get", async () => settings());
  server.handle("execution.set", async ({ mode, expectedVersion }) => {
    if (expectedVersion !== state.version)
      throw new RpcError(RpcErrorCodes.invalidParams, "version");
    state.mode = mode;
    state.version++;
    return settings();
  });
  server.handle("execution.todo.get", async ({ botId, conversationId }) => ({
    botId,
    conversationId,
    goal: "Development plan",
    items: [
      { id: "a", title: "Read the spec", status: "done" as const },
      { id: "b", title: "Answer the question", status: "in_progress" as const },
    ],
    version: 1,
    updatedAt: null,
  }));
  server.handle("execution.budget.get", async ({ runId }) => ({
    rootRunId: runId ?? ids.runId,
    limits: DEFAULT_EXECUTION_LIMITS,
    activeMillis: 42_000,
    tools: 3,
    requests: 3,
    childTasks: 0,
    activeChildren: 0,
    maxDepth: 0,
    observedTokens: 1200,
    knownCostUsd: 0.02,
    unknownUsageRequests: 0,
    unknownCostRequests: 0,
    exhaustedReason: null,
    version: 1,
  }));
  server.handle("execution.question.answer", async () => ({ ok: true as const }));
}
function registerChanges(server: ServerPeer, ids: ControlIds, state: ControlState) {
  const path = "/dev/project/index.html";
  server.handle("changes.turn", async () => ({
    checkpoint: { state: "retained" as const, checkpointId: ids.checkpointId, reason: null },
    runId: ids.runId,
    botId: ids.botId,
    root: "/dev/project",
    files: state.restored
      ? []
      : [
          {
            path,
            displayPath: "index.html",
            kind: "modify" as const,
            added: 1,
            removed: 1,
            binary: false,
            diffAvailable: true,
          },
        ],
    total: state.restored ? 0 : 1,
    truncated: false,
  }));
  const item = {
    id: crypto.randomUUID(),
    path,
    kind: "modify" as const,
    restorable: true,
    reason: null,
  };
  server.handle("changes.checkpoints.get", async () => ({
    id: ids.checkpointId,
    botId: ids.botId,
    runId: ids.runId,
    root: "/dev/project",
    state: "available" as const,
    version: 1,
    createdAt: now(),
    items: [item],
    truncated: false,
  }));
  server.handle("changes.checkpoints.restore", async ({ itemIds }) => {
    state.restored = true;
    return {
      id: crypto.randomUUID(),
      checkpointId: ids.checkpointId,
      state: "done" as const,
      recoveryPath: "/dev/recovery",
      items: itemIds.map((itemId) => ({ itemId, state: "restored" as const, reason: null })),
      createdAt: now(),
      updatedAt: now(),
    };
  });
}
function registerChat(server: ServerPeer, state: ControlState) {
  const yolo = (conversationId: string) => ({
    conversationId,
    enabled: state.yolo,
    enabledAt: state.yolo ? now() : null,
    isolation: { available: true },
  });
  server.handle("conversations.yolo.get", async ({ conversationId }) => yolo(conversationId));
  server.handle("conversations.yolo.set", async ({ conversationId, enabled }) => {
    state.yolo = enabled;
    return yolo(conversationId);
  });
  server.handle("chat.append", async ({ topicId, runId, requestId, mode, text }) => {
    const message: Message = {
      id: requestId,
      conversationId: topicId,
      role: "user",
      content: text,
      status: "done",
      runId,
      errorCode: null,
      usage: { chatAddition: { requestId, mode, state: "queued" } },
      createdAt: now(),
      updatedAt: now(),
    };
    return message;
  });
  server.handle("chat.retryPreview", async () => ({
    hash: "a".repeat(64),
    fileCount: 1,
    restoreFiles: true,
  }));
  server.handle("chat.retryFromMessage", async ({ requestId, botId, conversationId }) => ({
    requestId,
    state: "pending" as const,
    botId,
    conversationId,
  }));
  server.handle("chat.compact", async ({ conversationId }) => ({
    conversationId,
    mechanical: false,
  }));
  server.handle("chat.compact.cancel", async () => ({ ok: true as const }));
}
/** Handlers for every chat control the phone calls; state lives only in this fixture. */
export function registerControls(server: ServerPeer, ids: ControlIds, state: ControlState) {
  registerTopics(server, ids, state);
  registerExecution(server, ids, state);
  registerChanges(server, ids, state);
  registerChat(server, state);
  registerBrowser(server, ids.botId);
}
