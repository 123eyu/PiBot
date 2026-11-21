import type {
  AcpBot,
  AcpDefaultModel,
  AcpGroup,
  AcpGroupRunReceipt,
  AcpGroupSnapshot,
  AcpRunReceipt,
  AcpRuntimeEvent,
  AcpRuntimePort,
  AcpThinkingLevel,
} from "./types.ts";

type Topic = { botId: string; topicId: string };
type PreviewServer = {
  id: string;
  networkDomains: string[];
  auth: { secretNames: string[] };
} & ({ transport: "stdio"; command: string; args: string[] } | { transport: "http" | "builtin" });

/** Structural subset of the authenticated brain Peer; aggregate protocol stays in its caller. */
export interface AcpRpcMethods {
  "groups.acp.list": { params: Record<string, never>; result: AcpGroup[] };
  "groups.acp.get": { params: { groupId: string }; result: AcpGroup };
  "groups.topics.pickFolder": {
    params: { groupId: string };
    result: { choiceId: string; path: string; name: string } | null;
  };
  "groups.acp.topics.create": {
    params: { groupId: string; selection: { primary: string; readonly: string[] } };
    result: { topicId: string };
  };
  "groups.acp.topics.attach": {
    params: { groupId: string; topicId: string; cwd: string };
    result: { topicId: string };
  };
  "groups.acp.topics.rebind": {
    params: {
      groupId: string;
      topicId: string;
      selection: { primary: string; readonly: string[] };
    };
    result: null;
  };
  "groups.acp.topics.archive": { params: { groupId: string; topicId: string }; result: null };
  "groups.acp.send": {
    params: { groupId: string; topicId: string; text: string };
    result: AcpGroupRunReceipt;
  };
  "groups.acp.snapshot": { params: AcpGroupRunReceipt; result: AcpGroupSnapshot };
  "groups.acp.cancel": { params: AcpGroupRunReceipt; result: AcpGroupSnapshot };
  "bots.list": { params: Record<string, never>; result: AcpBot[] };
  "settings.get": {
    params: Record<string, never>;
    result: Awaited<ReturnType<AcpRuntimePort["settings"]>>;
  };
  "workplaces.pick": {
    params: { botId: string; association: "session" };
    result: { folder: { id: string } | null };
  };
  "topics.create": { params: { botId: string }; result: { id: string } };
  /** Continue an existing topic; the brain answers with fixed refusal codes. */
  "topics.acp.attach": { params: Topic & { cwd: string }; result: { topicId: string } };
  "topics.workplace.update": {
    params: Topic & { selection: { primary: string; readonly: string[] }; acpSession: true };
    result: unknown;
  };
  "topics.archive": { params: Topic; result: unknown };
  "models.list": {
    params: { availableOnly: true };
    result: {
      provider: string;
      id: string;
      name: string;
      reasoning?: boolean;
      thinkingLevels?: AcpThinkingLevel[];
    }[];
  };
  "providers.list": { params: Record<string, never>; result: { id: string; name: string }[] };
  "bots.update": {
    params:
      | { botId: string; modelProvider: string; modelId: string }
      | { botId: string; thinkingLevel: AcpThinkingLevel };
    result: unknown;
  };
  /** Only the default model; every other setting is written by the app's own screens. */
  "settings.set": {
    params: {
      defaultModel: AcpDefaultModel & { thinkingPreference?: AcpThinkingLevel | null };
    };
    result: unknown;
  };
  "conversations.yolo.set": {
    params: { conversationId: string; enabled: true };
    result: unknown;
  };
  "autoCheck.conversation.set": {
    params: { conversationId: string; enabled: boolean };
    result: unknown;
  };
  "chat.send": { params: Topic & { text: string }; result: AcpRunReceipt };
  "chat.abort": { params: { runId: string }; result: unknown };
  "approvals.resolve": {
    params: { id: string; decision: "allow" | "deny"; remember: false; allowSession?: true };
    result: unknown;
  };
  "plugins.previewImport": {
    params: { source: { kind: "json"; text: string } };
    result: {
      previewId: string;
      digest: string;
      manifest: { name: { zh: string; en: string }; servers: PreviewServer[] };
    };
  };
  "plugins.import": {
    params: {
      previewId: string;
      enable: true;
      expectedDigest: string;
      config: Record<string, never>;
      networkDomains: Record<string, string[]>;
    };
    result: unknown;
  };
  "plugins.cancelPreview": { params: { previewId: string }; result: unknown };
}

type RpcCall<K extends keyof AcpRpcMethods> = (
  method: K,
  params: AcpRpcMethods[K]["params"],
  options?: { signal: AbortSignal },
) => Promise<AcpRpcMethods[K]["result"]>;
type RpcCalls = { [K in keyof AcpRpcMethods]: RpcCall<K> }[keyof AcpRpcMethods];
type Overloads<T> = (T extends unknown ? (call: T) => void : never) extends (
  call: infer Calls,
) => void
  ? Calls
  : never;
type RpcEvents = { [Event in AcpRuntimeEvent as Event["method"]]: Event["payload"] };
type RpcSubscriptions = {
  [K in keyof RpcEvents]: (method: K, listener: (payload: RpcEvents[K]) => void) => () => void;
}[keyof RpcEvents];

export interface AcpRpcPort {
  // Concrete overloads let the caller's schema-typed Peer prove each method independently.
  call: Overloads<RpcCalls>;
  on: Overloads<RpcSubscriptions>;
}

export interface AcpFolderStaging {
  withPath<T>(path: string, action: () => Promise<T>, signal: AbortSignal): Promise<T>;
}
