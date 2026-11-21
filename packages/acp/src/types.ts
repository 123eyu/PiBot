import type { McpServer, SessionNotification } from "@agentclientprotocol/sdk";

export interface AcpBot {
  id: string;
  name: string;
  isMain: boolean;
  archivedAt?: string | null;
  modelProvider?: string | null;
  modelId?: string | null;
  thinkingLevel?: AcpThinkingLevel;
}

export type AcpThinkingLevel = "off" | "low" | "medium" | "high";
export interface AcpModel {
  provider: string;
  id: string;
  name: string;
  /** Levels this model accepts (the settings panel's list); absent means off only. */
  thinkingLevels?: AcpThinkingLevel[];
}
export interface AcpDefaultModel {
  provider: string;
  id: string;
  thinkingLevel: AcpThinkingLevel;
  /** The person's saved choice on the settings screen; kept when ACP changes the model. */
  thinkingPreference?: AcpThinkingLevel | null;
}

export type AcpTarget = { kind: "bot"; botId: string } | { kind: "group"; groupId: string };
export interface AcpGroup {
  id: string;
  name: string;
  coordinatorBotId: string;
  memberBotIds: string[];
  archivedAt?: string | null;
}
export interface AcpGroupRunReceipt extends AcpRunReceipt {
  groupId: string;
  topicId: string;
  cycleId: string;
  budgetRootRunId: string;
  runIds: string[];
}
export interface AcpGroupSnapshot extends AcpGroupRunReceipt {
  state:
    | "running"
    | "waiting_plan"
    | "waiting_input"
    | "paused"
    | "limited"
    | "failed"
    | "cancelled"
    | "completed";
  activeRunIds: string[];
  conversationIds: string[];
  taskIds: string[];
  workflowRunIds: string[];
  complete: boolean;
  terminal: boolean;
  drained: boolean;
  failureCode?: string;
  runs: { runId: string; botId: string; conversationId: string; status: string }[];
}

export interface AcpApproval {
  id: string;
  runId: string;
  toolCallId: string;
  category: string;
  risk: "normal" | "danger";
  title: string;
  facts: { kind: string; value: string; risk?: "normal" | "danger" }[];
  /** Brain allows answering this card for the rest of this ACP session (never persisted). */
  editorSession?: true;
  localized?: {
    zh: { title: string; facts: { kind: string; value: string; risk?: "normal" | "danger" }[] };
    en: { title: string; facts: { kind: string; value: string; risk?: "normal" | "danger" }[] };
  };
}

export interface AcpRunReceipt {
  runId: string;
  assistantMessageId: string;
}

interface AcpRunRoute {
  groupId?: string;
  cycleId?: string;
  botId?: string;
  conversationId?: string | null;
}

export type AcpRuntimeEvent =
  | {
      method: "chat.delta";
      payload: AcpRunRoute & { runId: string; messageId: string; text: string };
    }
  | {
      method: "chat.tool";
      payload: AcpRunRoute & {
        runId: string;
        toolCallId: string;
        phase: "start" | "output" | "end";
        tool: string;
        summary: string;
        output?: string;
        status?: "pending" | "running" | "done" | "error" | "blocked" | "aborted";
      };
    }
  | { method: "approval.requested"; payload: AcpRunRoute & AcpApproval }
  | {
      method: "approval.resolved";
      payload: {
        id: string;
        status: "allowed" | "denied" | "auto_denied" | "cancelled" | "expired";
        remembered: boolean;
      };
    }
  | {
      method: "chat.done";
      payload: AcpRunRoute & {
        runId: string;
        messageId: string;
        stopReason: string;
        /** Provider-reported token totals; shape is the brain's usage JSON. */
        usage?: unknown;
      };
    }
  | {
      method: "chat.error";
      payload: AcpRunRoute & { runId: string; messageId: string; code: string; message: string };
    };

export interface AcpMcpPreview {
  previewId: string;
  digest: string;
  name: { zh: string; en: string };
  servers: Array<{
    id: string;
    transport: "http" | "stdio" | "builtin";
    command?: string;
    args?: string[];
    networkDomains: string[];
    secretNames: string[];
  }>;
}

/** Narrow L4 port: the ACP translator never imports the product's aggregate protocol package. */
export interface AcpRuntimePort {
  ready(signal: AbortSignal): Promise<void>;
  bots(signal: AbortSignal): Promise<AcpBot[]>;
  /** Optional only for old Bot-only adapters; a group request never falls back to a Bot. */
  groups?(signal: AbortSignal): Promise<AcpGroup[]>;
  group?(groupId: string, signal: AbortSignal): Promise<AcpGroup>;
  createGroupTopic?(
    input: { groupId: string; cwd: string; additionalDirectories: string[]; yolo?: boolean },
    signal: AbortSignal,
  ): Promise<{ topicId: string }>;
  attachGroupTopic?(
    input: { groupId: string; topicId: string; cwd: string },
    signal: AbortSignal,
  ): Promise<{ topicId: string }>;
  rebindGroupTopic?(
    input: { groupId: string; topicId: string; cwd: string; additionalDirectories: string[] },
    signal: AbortSignal,
  ): Promise<void>;
  archiveGroupTopic?(
    input: { groupId: string; topicId: string },
    signal: AbortSignal,
  ): Promise<void>;
  sendGroupPrompt?(
    input: { groupId: string; topicId: string; text: string },
    signal: AbortSignal,
  ): Promise<AcpGroupRunReceipt>;
  groupSnapshot?(input: AcpGroupRunReceipt, signal: AbortSignal): Promise<AcpGroupSnapshot>;
  cancelGroup?(input: AcpGroupRunReceipt, signal: AbortSignal): Promise<AcpGroupSnapshot>;
  settings(signal: AbortSignal): Promise<{
    language: "system" | "zh" | "en";
    acpDefaultBotId?: string | null;
    defaultModel?: AcpDefaultModel | null;
  }>;
  createTopic(
    input: {
      botId: string;
      cwd: string;
      additionalDirectories: string[];
      /** YOLO on the new topic, asked for by the client. */
      yolo?: boolean;
    },
    signal: AbortSignal,
  ): Promise<{ topicId: string }>;
  archiveTopic(input: { botId: string; topicId: string }, signal: AbortSignal): Promise<void>;
  /**
   * Work in an existing topic instead of creating one. The brain refuses with a fixed code
   * (`topic_not_found` / `topic_wrong_bot` / `topic_archived` / `topic_folder_mismatch`) and never
   * reveals the topic's title or content.
   */
  attachTopic(
    input: { botId: string; topicId: string; cwd: string },
    signal: AbortSignal,
  ): Promise<{ topicId: string }>;
  /** Automatic checks on / off in one ACP topic while the brain runs (session _meta). */
  setAutoCheck?(topicId: string, enabled: boolean, signal: AbortSignal): Promise<void>;
  /** Points an ACP topic at other folders (same registration as a new session's folders). */
  rebindTopic(
    input: { botId: string; topicId: string; cwd: string; additionalDirectories: string[] },
    signal: AbortSignal,
  ): Promise<void>;
  /** Models Pi Bot can run now, for the session's "model" config option. */
  models(signal: AbortSignal): Promise<AcpModel[]>;
  providers(signal: AbortSignal): Promise<{ id: string; name: string }[]>;
  /** Changes only the Bot's model (the settings-panel switch). */
  setBotModel(
    input: { botId: string; provider: string; id: string },
    signal: AbortSignal,
  ): Promise<void>;
  /** The Bot's thinking level (the settings-panel switch); optional for older adapters. */
  setBotThinking?(
    input: { botId: string; thinkingLevel: AcpThinkingLevel },
    signal: AbortSignal,
  ): Promise<void>;
  /** The app-wide default model (Settings › Models); optional for older adapters. */
  setDefaultModel?(input: AcpDefaultModel, signal: AbortSignal): Promise<void>;
  sendPrompt(
    input: { botId: string; topicId: string; text: string },
    /** Cancellation is checked before dispatch; after dispatch this must return the owned run id. */
    signal: AbortSignal,
  ): Promise<AcpRunReceipt>;
  abort(runId: string, signal: AbortSignal): Promise<void>;
  resolveApproval(
    input: { id: string; decision: "allow" | "deny"; allowSession?: true },
    signal: AbortSignal,
  ): Promise<void>;
  previewMcp(servers: McpServer[], signal: AbortSignal): Promise<AcpMcpPreview>;
  importMcp(preview: AcpMcpPreview, signal: AbortSignal): Promise<void>;
  cancelMcpPreview(previewId: string, signal: AbortSignal): Promise<void>;
  onEvent(listener: (event: AcpRuntimeEvent) => void): () => void;
}

export interface AcpClientPort {
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(notification: SessionNotification): Promise<void>;
}
