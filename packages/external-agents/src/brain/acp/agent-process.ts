// A running agent process and the ACP sessions it serves. The process carries the sandbox boundary
// (fixed when it started); everything that belongs to one topic (its session id, options, turn and
// whether a turn is in flight) lives on that topic's session.
import type { InitializeResult, RequestPermissionParams, SessionUpdate } from "@pibot/acp-schemas";
import type { AgentSessionOptions } from "@pibot/external-agents-contract";
import { type AcpConnection, AcpRemoteError } from "./acp-connection.ts";
import { withCustomModel, withModel } from "./session-options.ts";

const IDLE_MS = 10 * 60_000;

/** The agent answered a model change with an error: the id is not one it accepts. */
export class AgentModelRefused extends Error {
  constructor() {
    super("agent_model_refused");
    this.name = "AgentModelRefused";
  }
}

/** What the current turn of a topic listens to; replaced per prompt. */
export interface TurnListener {
  update(update: SessionUpdate): void;
  permission(params: RequestPermissionParams, signal: AbortSignal): Promise<unknown>;
}

export type TopicKey = { botId: string; conversationId: string };

export class AgentProcess {
  readonly sessions = new Set<AgentSession>();
  /**
   * Every session id this process opened, attached or not: the agent may keep each in memory
   * until it exits, so its size caps sharing and a topic that left is never loaded here again.
   */
  readonly known = new Set<string>();
  private idle?: ReturnType<typeof setTimeout>;

  constructor(
    readonly connection: AcpConnection,
    readonly info: InitializeResult,
    readonly signature: string,
    readonly botId: string,
  ) {}

  /** The session an agent frame names; "" (a session still opening) matches nothing. */
  session(sessionId: string) {
    if (!sessionId) return undefined;
    for (const session of this.sessions) if (session.sessionId === sessionId) return session;
    return undefined;
  }

  /** A turn is opening or running on one of its sessions. */
  get busy() {
    for (const session of this.sessions) if (session.active) return true;
    return false;
  }

  /** Called when its last active session ended its turn: stops after the idle timeout. */
  touch(stop: () => void, idleMs = IDLE_MS) {
    clearTimeout(this.idle);
    this.idle = setTimeout(stop, idleMs);
    this.idle.unref?.();
  }
  hold() {
    clearTimeout(this.idle);
  }
}

/**
 * One topic's ACP session on a process. It keeps the shape callers used when a process served a
 * single topic (connection, info, sessionId, options, turn), so a turn talks to its own session.
 */
export class AgentSession {
  sessionId = "";
  /** A saved model waiting for the agent's model list (see openSession). */
  pendingModel?: string;
  options: AgentSessionOptions = {
    mode: null,
    model: null,
    settings: [],
    commands: [],
    refusedModel: null,
  };
  turn?: TurnListener;
  /**
   * Reserved from open until release: a turn is opening or running. At most one session of a
   * process is active, because Pi Bot does not know whether an agent runs prompts of two
   * sessions at once safely; a second topic that needs the agent meanwhile gets its own process.
   */
  active = false;
  /** This session's bridge token (in its `pibot` MCP entry); revoked when it leaves. */
  bridgeToken?: string;

  constructor(
    readonly process: AgentProcess,
    readonly key: TopicKey,
  ) {}

  get connection() {
    return this.process.connection;
  }
  get info() {
    return this.process.info;
  }
}

/**
 * Sets the session's model. One the agent listed goes through its select setting; any other id
 * (typed by the user) goes to `session/set_model`, then the select setting, and the agent's own
 * answer decides: an error from both is AgentModelRefused.
 */
export async function applyModel(session: AgentSession, value: string, signal: AbortSignal) {
  const { connection, sessionId } = session;
  const options = session.options;
  const listed = options.model?.options.some((option) => option.id === value);
  // Values are opaque: exactly what the agent advertised (or what the user typed), never cleaned.
  // A select setting takes its own values; ids from the ACP `models` list (configId "") and typed
  // ids go to session/set_model, falling back to the select setting when there is one.
  const configId = options.model?.configId || undefined;
  const viaConfig = (id: string) =>
    connection.request("session/set_config_option", { sessionId, configId: id, value }, signal);
  const viaModel = () =>
    connection.request("session/set_model", { sessionId, modelId: value }, signal);
  try {
    if (listed && configId) await viaConfig(configId);
    else
      await viaModel().catch(async (error: unknown) => {
        if (!(error instanceof AcpRemoteError) || !configId || listed) throw error;
        await viaConfig(configId);
      });
  } catch (error) {
    if (error instanceof AcpRemoteError) throw new AgentModelRefused();
    throw error;
  }
  session.options = listed ? withModel(options, value) : withCustomModel(options, value);
  return true;
}
