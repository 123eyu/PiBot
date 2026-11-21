// Opens one topic's ACP session on a running process: resumes the stored session when the agent
// can, else starts a new one, then applies the topic's saved picks with the agent's own values.
import { setTimeout as delay } from "node:timers/promises";
import { loadSessionResult, newSessionResult } from "@pibot/acp-schemas";
import type { AgentPreferences } from "../../store/index.ts";
import { AcpRemoteError } from "./acp-connection.ts";
import { AgentModelRefused, type AgentSession, applyModel } from "./agent-process.ts";
import { sessionOptions, withMode, withSetting } from "./session-options.ts";

/** ACP `AuthRequired`: the agent itself is not signed in. */
export const AUTH_REQUIRED = -32000;

export interface SessionOpenInput {
  agentId: string;
  cwd: string;
  /** The stored session of this topic, resumed when the agent can. */
  stored?: { sessionId: string; cwd: string };
  preferences: AgentPreferences;
  /** Agent-specific `_meta` for session/new and session/load (Claude: its own sandbox off). */
  sessionMeta?: Record<string, unknown>;
  /** Pi Bot's default mode when the user picked none (Claude: "default", which asks). */
  defaultMode?: string;
  /** The session's `pibot` MCP server; new, loaded and resumed sessions alike. */
  mcpServers?: readonly unknown[];
}

type Note = (entry: {
  event: string;
  method?: string;
  agentId?: string;
  configId?: string;
  reason?: string;
}) => void;

export async function openSession(
  session: AgentSession,
  input: SessionOpenInput,
  signal: AbortSignal,
  note: Note,
) {
  const { connection, info } = session;
  const base = {
    cwd: input.cwd,
    mcpServers: input.mcpServers ?? [],
    ...(input.sessionMeta ? { _meta: input.sessionMeta } : {}),
  };
  const stored =
    input.stored?.sessionId && input.stored.cwd === input.cwd ? input.stored : undefined;
  let state: unknown;
  if (stored) {
    const resume = !!(
      info.agentCapabilities?.sessionCapabilities as { resume?: unknown } | undefined
    )?.resume;
    const method = resume
      ? "session/resume"
      : info.agentCapabilities?.loadSession
        ? "session/load"
        : undefined;
    if (method)
      try {
        // Set before the request so the replay's option updates reach this session.
        session.sessionId = stored.sessionId;
        state = loadSessionResult.parse(
          (await connection.request(method, { ...base, sessionId: stored.sessionId }, signal)) ??
            {},
        );
      } catch (error) {
        if (error instanceof AcpRemoteError && error.code === AUTH_REQUIRED) throw error;
        // A lost or expired session starts fresh; the topic's history stays in Pi Bot.
        note({ event: "agent_resume_failed", method, agentId: input.agentId });
        session.sessionId = "";
        state = undefined;
      }
  }
  if (!session.sessionId) {
    const created = newSessionResult.parse(await connection.request("session/new", base, signal));
    session.sessionId = created.sessionId;
    state = created;
  }
  const opened = sessionOptions(state);
  // Replay notifications may already have delivered a list while load/new was in flight.
  session.options = {
    ...opened,
    model: opened.model?.options.length
      ? opened.model
      : session.options.model?.options.length
        ? session.options.model
        : opened.model,
  };
  if (opened.model && !opened.model.options.length && !session.options.model?.options.length) {
    const until = performance.now() + 5000;
    while (!session.options.model?.options.length && performance.now() < until) {
      await delay(50, undefined, { signal });
    }
    if (!session.options.model?.options.length) {
      try {
        // Fetching choices leaves an empty entry in the agent's own history (visible in Cursor).
        const extra = newSessionResult.parse(await connection.request("session/new", base, signal));
        if (extra.sessionId !== session.sessionId) session.process.known.add(extra.sessionId);
        const recovered = sessionOptions(extra);
        // The extra session supplies choices only: the topic keeps its original identity/mode.
        if (recovered.model?.options.length) {
          session.options = {
            ...session.options,
            model: recovered.model,
            settings: [
              ...session.options.settings,
              ...recovered.settings.filter(
                (item) =>
                  !session.options.settings.some((known) => known.configId === item.configId),
              ),
            ],
          };
        }
      } catch (error) {
        signal.throwIfAborted();
        if (connection.isClosed) throw error;
        note({ event: "agent_model_list_refresh_failed", agentId: input.agentId });
      }
    }
  }
  // The saved choices are applied with the exact values the agent advertised (model values are
  // opaque, e.g. Cursor's `composer-2.5[fast=true]`). An agent that refuses one does not fail the
  // start: it keeps its own value and the log names the method and setting (never the value).
  const refused = (method: string, configId?: string) => (error: unknown) => {
    if (!(error instanceof AcpRemoteError)) throw error;
    note({
      event: "agent_option_refused",
      agentId: input.agentId,
      method,
      ...(configId ? { configId } : {}),
      reason: `agent_error_${error.code}`,
    });
    return false;
  };
  const mode = input.preferences.mode ?? input.defaultMode;
  if (
    mode &&
    session.options.mode &&
    session.options.mode.current !== mode &&
    session.options.mode.options.some((option) => option.id === mode)
  ) {
    const done = await connection
      .request("session/set_mode", { sessionId: session.sessionId, modeId: mode }, signal)
      .then(() => true, refused("session/set_mode"));
    if (done) session.options = withMode(session.options, mode);
  }
  const model = input.preferences.model ?? session.pendingModel;
  session.pendingModel = undefined;
  // Cursor can open a session before its model list has loaded (an empty list, current ""):
  // the saved model is applied when the agent announces its models, not refused now.
  if (model && !session.options.model?.options.length) session.pendingModel = model;
  else if (model && session.options.model?.current !== model) {
    // A typed id the agent refuses is not a failed start: it runs on its own default and the
    // picker says which id was refused.
    const applied = await applyModel(session, model, signal).catch((error: unknown) => {
      if (error instanceof AgentModelRefused) return false;
      throw error;
    });
    if (!applied) {
      note({
        event: "agent_model_refused",
        agentId: input.agentId,
        configId: session.options.model?.configId ?? "model",
      });
      session.options = { ...session.options, refusedModel: model };
    }
  }
  for (const [configId, value] of Object.entries(input.preferences.config ?? {})) {
    const setting = session.options.settings.find((item) => item.configId === configId);
    if (!setting || setting.current === value || !setting.options.some((o) => o.id === value))
      continue;
    const done = await connection
      .request(
        "session/set_config_option",
        { sessionId: session.sessionId, configId, value },
        signal,
      )
      .then(() => true, refused("session/set_config_option", configId));
    if (done) session.options = withSetting(session.options, configId, value);
  }
}
