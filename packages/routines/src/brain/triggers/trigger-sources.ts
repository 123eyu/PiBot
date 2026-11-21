import type { LocalService } from "@pibot/brain/kit";
import { type ConnectionCheckId, type ConnectorTool, RpcError } from "@pibot/protocol";
import { BotsRepo } from "@pibot/storage";
import { z } from "zod";
import {
  AppTriggerError,
  catalogTools,
  connectionBlock,
  connectionValue,
  isLocalCalendar,
  readConnection,
  usableConnection,
} from "./app-read.ts";
import { CONNECTION_CHECK_IDS, presetCall } from "./connection-checks.ts";

const CalendarsSchema = z.object({
  items: z
    .array(z.object({ id: z.string().min(1).max(4096), title: z.string().max(512).catch("") }))
    .max(100),
});

function requireBot(local: LocalService, botId: string) {
  const bot = new BotsRepo(local.deps.db).get(botId);
  if (!bot || bot.archivedAt) throw new RpcError(-32602, "bot_unavailable");
}

/**
 * What the trigger editor may offer this Bot, from the local catalog only (no connection is
 * called). Connections come from the generic connector registry, so an imported GitHub MCP or
 * plugin shows its presets like any other connection.
 */
export function triggerSources(local: LocalService, botId: string) {
  requireBot(local, botId);
  const byConnector = new Map<string, ConnectorTool[]>();
  for (const tool of catalogTools(local, botId))
    byConnector.set(tool.connectorId, [...(byConnector.get(tool.connectorId) ?? []), tool]);
  const connections: { connectorId: string; name: string; checks: ConnectionCheckId[] }[] = [];
  const calendars: { connectorId: string; name: string }[] = [];
  const blocked: {
    connectorId: string;
    name: string;
    reason: "ask" | "not_running" | "permission" | "no_read";
  }[] = [];
  for (const [connectorId, tools] of byConnector) {
    const connector = usableConnection(local, botId, connectorId);
    if (!connector) {
      // Second-Mac test: a visible connection that only asks first read as "bring one over".
      const block = connectionBlock(local, botId, connectorId);
      const name = local.connectors?.get(connectorId)?.name.slice(0, 500);
      if (block && name && blocked.length < 200) blocked.push({ connectorId, name, reason: block });
      continue;
    }
    const name = connector.name.slice(0, 500);
    if (isLocalCalendar(local, connector)) {
      if (
        tools.some((tool) => tool.tool === "list_events" && tool.readOnly) &&
        calendars.length < 10
      )
        calendars.push({ connectorId, name });
      continue;
    }
    if (connections.length < 200)
      connections.push({
        connectorId,
        name,
        checks: CONNECTION_CHECK_IDS.filter((check) => presetCall(check, tools)),
      });
  }
  // Second-Mac test: a connection whose tools are all still writes never reached the loop above,
  // so the editor said 「先在连接里带过来一个」 although the Bot had one.
  for (const tool of catalogTools(local, botId, undefined, false)) {
    if (byConnector.has(tool.connectorId) || blocked.length >= 200) continue;
    if (blocked.some((entry) => entry.connectorId === tool.connectorId)) continue;
    const connector = local.connectors?.get(tool.connectorId);
    if (connector)
      blocked.push({
        connectorId: tool.connectorId,
        name: connector.name.slice(0, 500),
        reason: "no_read",
      });
  }
  return { connections, calendars, blocked };
}

/** The calendars a calendar trigger can be limited to: one audited read-only call. */
export async function calendarList(
  local: LocalService,
  input: { botId: string; connectorId: string },
  signal: AbortSignal,
) {
  requireBot(local, input.botId);
  const connector = usableConnection(local, input.botId, input.connectorId);
  if (!connector || !isLocalCalendar(local, connector))
    throw new RpcError(-32602, "calendar_trigger_unavailable");
  try {
    const value = await readConnection(
      local,
      { botId: input.botId },
      { connectorId: connector.id, tool: "list_calendars", args: {} },
      "routine_calendar_list",
      signal,
      () => true,
    );
    return { items: CalendarsSchema.parse(connectionValue(value)).items };
  } catch (error) {
    signal.throwIfAborted();
    // The editor only needs to know the list is unavailable; the reason is in the audit.
    throw new RpcError(
      -32602,
      error instanceof AppTriggerError && error.code === "connection_trigger_unavailable"
        ? "calendar_trigger_unavailable"
        : "calendar_list_failed",
    );
  }
}
