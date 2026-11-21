import type { LocalService } from "@pibot/brain/kit";
import { ConnectorToolError, connectorPreauthIssue } from "@pibot/brain/kit";
import { connectorCallRequest } from "@pibot/policy";
import {
  type AuditDetail,
  type Connector,
  ConnectorCallError,
  type ConnectorTool,
} from "@pibot/protocol";

/** Statuses after which a connection will not come back on its own; the trigger pauses. */
export const BROKEN_CONNECTOR_STATUSES = new Set([
  "disabled",
  "stopping",
  "needs_setup",
  "needs_auth",
  "error",
]);
const CALL_TIMEOUT_MS = 30_000;

export class AppTriggerError extends Error {
  /** The fixed code underneath (e.g. connector_secret_denied), so a failed check can be traced. */
  constructor(
    readonly code: string,
    readonly cause?: string,
  ) {
    super(code);
  }
}

/** The fixed code of a failed check, for audit and logs (never a message, which may hold data). */
export function appTriggerErrorCode(error: unknown) {
  if (error instanceof AppTriggerError || error instanceof ConnectorToolError) return error.code;
  if (error instanceof ConnectorCallError)
    return error.reason ?? (error.outcome === "unknown" ? "outcome_unknown" : error.code);
  if (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))
    return "cancelled";
  return "connection_trigger_check_failed";
}

/**
 * Whether this Bot may read the connection with nobody present: the same decision as a routine
 * pre-authorization of the connection (permission not "never", installed, switched on, ready,
 * visible to the Bot, and not set to "ask every time").
 */
export function usableConnection(local: LocalService, botId: string, connectorId: string) {
  if (
    connectorPreauthIssue(local, botId, {
      category: "connector",
      scope: { kind: "connector", connectorId },
    })
  )
    return undefined;
  return local.connectors?.get(connectorId);
}

/** Why `usableConnection` refused a connection, in the words the trigger editor can show. */
export function connectionBlock(
  local: LocalService,
  botId: string,
  connectorId: string,
): "ask" | "not_running" | "permission" | undefined {
  const issue = connectorPreauthIssue(local, botId, {
    category: "connector",
    scope: { kind: "connector", connectorId },
  });
  if (!issue) return undefined;
  if (issue === "permission_ceiling") return "permission";
  const connector = local.connectors?.get(connectorId);
  if (!connector || !local.connectors) return undefined;
  const access = local.connectors.access(connectorId);
  if (access.mode === "ask_first" || connector.confirmationMode === "always_ask") return "ask";
  return "not_running";
}

/** The built-in local calendar app, whose catalog and arguments Pi Bot itself defines. */
export function isLocalCalendar(local: LocalService, connector: Connector) {
  const plugin = local.connectors?.plugin(connector.pluginInstallationId);
  return plugin?.sourceKind === "builtin" && plugin.pluginId === "pibot.calendar";
}

/** Every enabled tool the current catalogs show this Bot (bounded); presets pick read-only ones. */
export function catalogTools(
  local: LocalService,
  botId: string,
  connectorId?: string,
  readOnly = true,
) {
  const port = local.connectors;
  const tools: ConnectorTool[] = [];
  if (!port) return tools;
  let cursor: string | undefined;
  // 20 pages of 50 is far beyond any real catalog; the cap only bounds a broken one.
  for (let page = 0; page < 20; page++) {
    const result = port.discoverToolsForBot(
      botId,
      { ...(connectorId ? { connectorId } : {}), limit: 50, ...(cursor ? { cursor } : {}) },
      readOnly,
    );
    for (const tool of result.items) if (tool.enabled) tools.push(tool);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return tools;
}

/**
 * One read-only tool call made by the program for a trigger, not by a model. It takes the same
 * gates as a Bot's call: trusted target resolution, the policy decision for this Bot (it must be
 * "allow": nobody is there to answer a question), dispatch that re-checks both, and audit entries
 * before and after. Arguments and results never enter the audit or the log.
 */
export async function readConnection(
  local: LocalService,
  owner: { botId: string; routineId?: string },
  input: { connectorId: string; tool: string; args: Record<string, import("zod").JSONType> },
  reasonCode: string,
  signal: AbortSignal,
  stillCurrent: () => boolean,
): Promise<unknown> {
  const port = local.connectors;
  const connector = usableConnection(local, owner.botId, input.connectorId);
  if (!port || !connector) throw new AppTriggerError("connection_trigger_unavailable");
  const call = { ...input, catalogVersion: connector.catalogVersion };
  let prepared: ReturnType<typeof port.resolveTool>;
  try {
    prepared = port.resolveTool(owner.botId, call);
  } catch (error) {
    // Owner's Mac, 2026-11-01: the check failed twice with only this code; keep the fixed reason.
    throw new AppTriggerError(
      "connection_trigger_tool_unavailable",
      error instanceof ConnectorToolError ? error.code : "resolve_failed",
    );
  }
  if (!prepared.tool.readOnly) throw new AppTriggerError("connection_trigger_tool_unavailable");
  const policy = await local.getPolicy(signal);
  const result = await policy.evaluate({
    botId: owner.botId,
    request: connectorCallRequest(prepared),
    settings: local.permissions.effective(owner.botId),
    permissionSources: local.permissions.sources(owner.botId),
    // A connection read touches no folder; the Bot's folders are not part of this decision.
    workplace: { home: local.deps.dataDir, folders: [], currentId: "home" },
    signal,
  });
  const started = performance.now();
  const audit = (reason: string, decision?: AuditDetail["decision"], failure?: string) =>
    local.approvals.audit.append({
      botId: owner.botId,
      kind: "connector.called",
      summary: "Routine trigger check / 例行任务触发检查",
      detail: {
        ...(owner.routineId ? { routineId: owner.routineId } : {}),
        source: "routine",
        actor: "system",
        connectorId: connector.id,
        revision: connector.revision,
        catalogVersion: connector.catalogVersion,
        toolName: prepared.tool.tool.slice(0, 80),
        category: "connector",
        ...(decision ? { decision } : {}),
        // A finished read counts as the connection's last use (connections page), like a poll.
        ...(reason.endsWith("_done") ? { reason: "routine_trigger" } : {}),
        // Only the fixed code of a failure, never its message.
        ...(failure ? { reason: failure } : {}),
        durationMs: Math.round(performance.now() - started),
        reasonCode: reason,
      },
    });
  if (result.decision !== "allow") {
    audit(`${reasonCode}_denied`, "deny");
    throw new AppTriggerError("connection_trigger_denied");
  }
  audit(`${reasonCode}_running`, "allow");
  try {
    const value = await port.dispatch(
      owner.botId,
      call,
      prepared,
      AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
      () => {
        if (!stillCurrent() || !usableConnection(local, owner.botId, connector.id))
          throw new AppTriggerError("connection_trigger_unavailable");
      },
    );
    audit(`${reasonCode}_done`);
    return value;
  } catch (error) {
    audit(`${reasonCode}_error`, undefined, appTriggerErrorCode(error));
    throw error;
  }
}

/**
 * The tool's answer as data. MCP wraps it in a single text part (often JSON), Pi Bot's native
 * apps in `{ ok, value }`; an error answer is a failed check, never "nothing new".
 */
export function connectionValue(value: unknown): unknown {
  for (let depth = 0; depth < 4; depth++) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const item = value as Record<string, unknown>;
    if (item.isError === true || item.ok === false)
      throw new AppTriggerError("connection_trigger_tool_failed");
    if (item.ok === true && "value" in item) value = item.value;
    else if (item.structuredContent && typeof item.structuredContent === "object")
      value = item.structuredContent;
    else if (Array.isArray(item.content)) {
      const texts = item.content.flatMap((part) =>
        part && typeof part === "object" && (part as { type?: unknown }).type === "text"
          ? [String((part as { text?: unknown }).text ?? "")]
          : [],
      );
      const text = texts.join("\n");
      if (text.length > 4_194_304) throw new AppTriggerError("connection_trigger_result_too_large");
      try {
        value = JSON.parse(text);
      } catch {
        // Plain text is still a result: its fingerprint is compared as one item.
        return text;
      }
    } else return value;
  }
  return value;
}
