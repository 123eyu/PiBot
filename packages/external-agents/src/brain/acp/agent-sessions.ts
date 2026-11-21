// Agent processes and the topics they serve. A process's outer sandbox (folders, write roots,
// isolation, environment) is fixed when it starts, so only topics with exactly the same launch
// signature may share one, each with its own ACP session. Sharing spares a group's later steps a
// cold start (Codex took 28 s per step, owner's Mac 2026-11-15). A process outlives its turns for
// a while and stops when all its sessions have been idle, on retire and on shutdown.
import {
  ACP_CLIENT_PROTOCOL_VERSION,
  initializeResult,
  requestPermissionParams,
  type SessionUpdate,
  sessionNotification,
} from "@pibot/acp-schemas";
import { ConnectorStartError } from "@pibot/execution";
import type { AgentSessionOptions, ExternalAgentId } from "@pibot/external-agents-contract";
import type { AgentPreferences } from "../../store/index.ts";
import { maskAccount } from "../privacy/account-mask.ts";
import { AcpClosedError, AcpConnection, AcpRemoteError } from "./acp-connection.ts";
import { AgentProcess, AgentSession, applyModel, type TopicKey } from "./agent-process.ts";
import { type LaunchDeps, type LaunchInput, launchAgent } from "./launch.ts";
import { AUTH_REQUIRED, openSession } from "./session-open.ts";
import { applyOptionUpdate } from "./session-options.ts";

export {
  AgentModelRefused,
  AgentProcess,
  AgentSession,
  applyModel,
  type TurnListener,
} from "./agent-process.ts";

/**
 * Start deadlines. Windows is far slower to start an agent: `opencode acp` took 30–36 s to answer
 * initialize in the Windows VM and session/new another 14–73 s (2026-11-14), so the first turn
 * failed at the old 30 s limit.
 */
const INITIALIZE_MS = { default: 30_000, win32: 120_000 } as const;
const SESSION_MS = { default: 90_000, win32: 180_000 } as const;
const limit = (table: { default: number; win32: number }, platform: NodeJS.Platform) =>
  platform === "win32" ? table.win32 : table.default;
/** Sessions one process opens before it stops taking new topics (the agent keeps them all). */
const MAX_SESSIONS = 8;
const MAX_PREWARMED = 2;
const PREWARM_IDLE_MS = 5 * 60_000;

/** Why a start failed, for the log only (never shown, never agent output). */
function startFailure(error: unknown) {
  if (error && typeof error === "object" && "name" in error && error.name === "TimeoutError")
    return "timeout";
  if (error instanceof AcpClosedError) return "exited";
  if (error instanceof AcpRemoteError) return `agent_error_${error.code}`;
  if (error && typeof error === "object" && "name" in error && error.name === "ZodError")
    return "protocol";
  return "other";
}

export class AgentStartError extends Error {
  constructor(readonly code: "agent_unavailable" | "agent_login_required" | "agent_failed") {
    super(code);
    this.name = "AgentStartError";
  }
}

export interface OpenInput {
  key: TopicKey;
  agentId: ExternalAgentId;
  launch: Omit<LaunchInput, "signal">;
  /** The stored session of this topic, resumed when the agent can. */
  stored?: { sessionId: string; cwd: string };
  preferences: AgentPreferences;
  /** Agent-specific `_meta` for session/new and session/load (Claude: its own sandbox off). */
  sessionMeta?: Record<string, unknown>;
  /** Pi Bot's default mode when the user picked none (Claude: "default", which asks). */
  defaultMode?: string;
  signal: AbortSignal;
}

/**
 * Everything that shapes the process or its boundary: program, adapter (its versioned folder and
 * read roots), environment, the agent's allowances (agent + custom command), folders, isolation,
 * and the Bot and group whose Pi Bot folders the sandbox may open as write roots.
 */
function launchSignature(input: OpenInput) {
  const launch = input.launch;
  return JSON.stringify([
    input.agentId,
    launch.agent,
    launch.target,
    launch.env ?? {},
    launch.writeRoots,
    launch.cwd,
    launch.isolation,
    launch.botId ?? null,
    launch.groupId ?? null,
    launch.offline ?? false,
  ]);
}

/** Pi Bot's MCP bridge as the sessions see it: a token per session, revoked when it ends. */
export interface SessionBridge {
  open(key: TopicKey): { token: string; servers: unknown[] } | undefined;
  revoke(token: string): void;
}

const keyOf = (key: TopicKey) => `${key.botId}:${key.conversationId}`;
const deadline = (signal: AbortSignal, ms: number) =>
  AbortSignal.any([signal, AbortSignal.timeout(ms)]);

type Note = (entry: {
  event: string;
  botId?: string;
  method?: string;
  agentId?: string;
  configId?: string;
  step?: string;
  reason?: string;
  errorName?: string;
  issuePath?: string;
  stderr?: string;
}) => void;

export class AgentSessions {
  private readonly topics = new Map<string, AgentSession>();
  private readonly processes = new Set<AgentProcess>();
  private prewarming = 0;
  private readonly starting = new Map<string, Promise<AgentSession>>();

  constructor(
    private readonly deps: LaunchDeps & { version: string; sessionBridge?: SessionBridge },
    private readonly note: Note,
    /** The agent changed its own options (mode, settings, commands): the owner persists them. */
    private readonly onOptions?: (key: TopicKey, options: AgentSessionOptions) => void,
  ) {}

  /**
   * The topic's live session for this launch signature: its own one, else a new session on an
   * idle process with the same signature, else a new process. Reserved for the caller's turn
   * until release.
   */
  async open(input: OpenInput): Promise<AgentSession> {
    const key = keyOf(input.key);
    const signature = launchSignature(input);
    const pending = this.starting.get(key);
    if (pending) await pending.catch(() => undefined);
    const current = this.topics.get(key);
    if (
      current &&
      !current.connection.isClosed &&
      current.process.signature === signature &&
      !current.process.busy
    ) {
      current.active = true;
      current.process.hold();
      return current;
    }
    // A changed signature, or another topic's turn running on this process (sessions of one
    // process never run turns at once): the topic leaves it and resumes its session elsewhere.
    if (current) await this.detach(current);
    const opening = this.attach(input, signature).finally(() => this.starting.delete(key));
    this.starting.set(key, opening);
    return opening;
  }

  /** Starts an initialized process without opening an ACP session, so the next topic can reuse it. */
  async prewarm(input: OpenInput): Promise<boolean> {
    const signature = launchSignature(input);
    if (this.reusable(input, signature)) return false;
    if (
      this.prewarming +
        [...this.processes].filter((process) => process.sessions.size === 0).length >=
      MAX_PREWARMED
    )
      return false;
    this.prewarming++;
    try {
      const process = await this.launch(input, signature);
      process.touch(() => void this.stopProcess(process), PREWARM_IDLE_MS);
      return true;
    } finally {
      this.prewarming--;
    }
  }

  /** The turn ended: the process may serve the next message until all its sessions idle out. */
  release(key: TopicKey) {
    const session = this.topics.get(keyOf(key));
    if (!session) return;
    session.turn = undefined;
    session.active = false;
    const process = session.process;
    if (!process.busy) process.touch(() => void this.stopProcess(process));
  }

  get(key: TopicKey) {
    return this.topics.get(keyOf(key));
  }

  /** Stops the process serving this topic, with every session on it. */
  async stop(name: string) {
    const session = this.topics.get(name);
    this.topics.delete(name);
    if (session) await this.stopProcess(session.process);
  }

  async stopBot(botId: string) {
    await Promise.all(
      [...this.processes]
        .filter((process) => process.botId === botId)
        .map((process) => this.stopProcess(process)),
    );
  }

  async dispose() {
    await Promise.all([...this.processes].map((process) => this.stopProcess(process)));
  }

  private async attach(input: OpenInput, signature: string): Promise<AgentSession> {
    const shared = this.reusable(input, signature);
    if (shared)
      try {
        if (shared.sessions.size === 0) this.note({ event: "prewarm_hit", botId: input.key.botId });
        return await this.openOn(shared, input);
      } catch (error) {
        // The shared process exited meanwhile: this topic starts its own below.
        if (!(error instanceof AcpClosedError) || input.signal.aborted)
          throw this.startError(error, shared.connection, input, "session");
      }
    const process = await this.launch(input, signature);
    try {
      return await this.openOn(process, input);
    } catch (error) {
      throw this.startError(error, process.connection, input, "session");
    }
  }

  /** An idle process of the same Bot and signature that can take one more session. */
  private reusable(input: OpenInput, signature: string) {
    for (const process of this.processes)
      if (
        process.botId === input.key.botId &&
        process.signature === signature &&
        !process.connection.isClosed &&
        !process.busy &&
        process.known.size < MAX_SESSIONS &&
        // A topic that left this process may still be loaded in the agent; never load it twice.
        !(input.stored?.sessionId && process.known.has(input.stored.sessionId))
      )
        return process;
    return undefined;
  }

  /** Opens the topic's session on a process; on failure the process stops if nothing else uses it. */
  private async openOn(process: AgentProcess, input: OpenInput) {
    const key = keyOf(input.key);
    // Reserved before the first await, so no other topic picks this process meanwhile.
    const session = new AgentSession(process, input.key);
    session.active = true;
    process.sessions.add(session);
    process.hold();
    this.topics.set(key, session);
    const bridge = this.deps.sessionBridge?.open(input.key);
    if (bridge) session.bridgeToken = bridge.token;
    try {
      await openSession(
        session,
        {
          agentId: input.agentId,
          cwd: input.launch.cwd,
          ...(input.stored ? { stored: input.stored } : {}),
          preferences: input.preferences,
          ...(input.sessionMeta ? { sessionMeta: input.sessionMeta } : {}),
          ...(input.defaultMode ? { defaultMode: input.defaultMode } : {}),
          ...(bridge ? { mcpServers: bridge.servers } : {}),
        },
        deadline(input.signal, limit(SESSION_MS, this.deps.platform)),
        this.note,
      );
      // Two topics on one session id would see each other's turns: an agent that hands out an
      // id it already gave is not shared.
      if (process.known.has(session.sessionId)) {
        this.note({ event: "agent_session_reused", agentId: input.agentId });
        throw new AgentStartError("agent_failed");
      }
      process.known.add(session.sessionId);
      return session;
    } catch (error) {
      await this.detach(session);
      throw error;
    }
  }

  /** Takes a topic off its process; a process left with no session stops. */
  private async detach(session: AgentSession) {
    const key = keyOf(session.key);
    if (this.topics.get(key) === session) this.topics.delete(key);
    this.revoke(session);
    const process = session.process;
    process.sessions.delete(session);
    if (!process.sessions.size) await this.stopProcess(process);
    else if (!process.busy) process.touch(() => void this.stopProcess(process));
  }

  private async stopProcess(process: AgentProcess) {
    this.forget(process);
    process.hold();
    await process.connection.close().catch(() => undefined);
  }

  /** Synchronous, so a topic opening right after a stop never picks the stopping process. */
  private forget(process: AgentProcess) {
    this.processes.delete(process);
    for (const session of process.sessions) {
      const key = keyOf(session.key);
      if (this.topics.get(key) === session) this.topics.delete(key);
      this.revoke(session);
    }
    process.sessions.clear();
  }

  private revoke(session: AgentSession) {
    if (!session.bridgeToken) return;
    this.deps.sessionBridge?.revoke(session.bridgeToken);
    session.bridgeToken = undefined;
  }

  /** Starts the program and initializes ACP; the process serves no session yet. */
  private async launch(input: OpenInput, signature: string): Promise<AgentProcess> {
    let stream: Awaited<ReturnType<typeof launchAgent>>;
    try {
      stream = await launchAgent(this.deps, { ...input.launch, signal: input.signal });
    } catch (error) {
      input.signal.throwIfAborted();
      // Before any ACP frame: the sandbox or the program did not start (Linux: bwrap, seccomp,
      // a missing helper). The exec code and reason name it; the host's stderr says the rest.
      const facts = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
      const tail = error instanceof ConnectorStartError ? error.diagnosis.stderrTail : "";
      this.note({
        event: "agent_launch_failed",
        agentId: input.agentId,
        errorName: error instanceof Error ? error.name : typeof error,
        ...(typeof facts.code === "string" ? { reason: facts.code.slice(0, 80) } : {}),
        ...(typeof facts.reason === "string" ? { step: facts.reason.slice(0, 80) } : {}),
        ...(tail ? { stderr: maskAccount(this.deps.redactor.redact(tail)).slice(-600) } : {}),
      });
      throw error;
    }
    const connection = new AcpConnection(stream, (entry) =>
      this.note({ ...entry, agentId: input.agentId }),
    );
    try {
      const info = initializeResult.parse(
        await connection.request(
          "initialize",
          {
            protocolVersion: ACP_CLIENT_PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "pibot", title: "Pi Bot", version: this.deps.version },
          },
          deadline(input.signal, limit(INITIALIZE_MS, this.deps.platform)),
        ),
      );
      if (info.protocolVersion !== ACP_CLIENT_PROTOCOL_VERSION) {
        this.note({
          event: "agent_start_failed",
          agentId: input.agentId,
          step: "initialize",
          reason: "protocol",
        });
        throw new AgentStartError("agent_failed");
      }
      const process = new AgentProcess(connection, info, signature, input.key.botId);
      // Frames are routed by the session they name; one naming no session of this process (or a
      // session still opening) reaches no topic.
      connection.onNotification("session/update", (params) => {
        const parsed = sessionNotification.safeParse(params);
        const session = parsed.success ? process.session(parsed.data.sessionId) : undefined;
        if (parsed.success && session) this.update(session, parsed.data.update, input.agentId);
      });
      connection.onRequest("session/request_permission", async (params, signal) => {
        const parsed = requestPermissionParams.safeParse(params);
        const session = parsed.success ? process.session(parsed.data.sessionId) : undefined;
        if (!parsed.success || !session?.turn) return { outcome: { outcome: "cancelled" } };
        return session.turn.permission(parsed.data, signal);
      });
      this.processes.add(process);
      connection.onClose(() => this.forget(process));
      return process;
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw this.startError(error, connection, input, "initialize");
    }
  }

  /** One session's update: its own options, else its current turn's output. */
  private update(session: AgentSession, update: SessionUpdate, agentId: string) {
    const options = applyOptionUpdate(session.options, update);
    if (!options) {
      // Updates before the turn listener exists are session/load replay: history Pi Bot has.
      session.turn?.update(update);
      return;
    }
    session.options = options;
    const pending = session.pendingModel;
    if (pending && options.model?.options.length) {
      session.pendingModel = undefined;
      void applyModel(session, pending, AbortSignal.timeout(15_000))
        .catch(() => {
          this.note({ event: "agent_model_refused", agentId });
          session.options = { ...session.options, refusedModel: pending };
        })
        .finally(() => this.onOptions?.(session.key, session.options));
      return;
    }
    this.onOptions?.(session.key, options);
  }

  /** The error a failed start surfaces, with the facts logged (never agent output or values). */
  private startError(
    error: unknown,
    connection: AcpConnection,
    input: OpenInput,
    step: "initialize" | "session",
  ): unknown {
    if (error instanceof AgentStartError) return error;
    if (error instanceof AcpRemoteError && error.code === AUTH_REQUIRED)
      return new AgentStartError("agent_login_required");
    if (input.signal.aborted) return input.signal.reason;
    // Facts only: the error class, where a frame broke the schema (path, never values) and the
    // agent's own last stderr, redacted, account-masked and capped.
    const issue =
      error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)
        ? (error.issues[0] as { path?: unknown[] } | undefined)?.path?.map(String).join(".")
        : undefined;
    const tail = connection.stderrTail();
    this.note({
      event: "agent_start_failed",
      agentId: input.agentId,
      step,
      reason: startFailure(error),
      errorName: error instanceof Error ? error.name : typeof error,
      ...(issue ? { issuePath: issue.slice(0, 200) } : {}),
      ...(tail ? { stderr: maskAccount(this.deps.redactor.redact(tail)).slice(-600) } : {}),
    });
    return new AgentStartError("agent_failed");
  }
}
