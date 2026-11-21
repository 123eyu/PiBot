import { randomUUID } from "node:crypto";
import type { ConnectorCallInput, PreparedConnector } from "@pibot/protocol-base";
import type { LocalRun } from "../local-run.ts";

/** A display lookup is still a read tool: reuse its policy, consent, audit and dispatch. */
export async function snapshotCalendarName(
  run: LocalRun,
  input: ConnectorCallInput,
  prepared: PreparedConnector,
  signal: AbortSignal,
) {
  const { context, local } = run;
  const connector = prepared.connector;
  if (
    !context.conversationId ||
    prepared.tool.capabilityTool !== "calendar_create_event" ||
    prepared.tool.tool !== "create_event" ||
    typeof input.args.calendarId !== "string"
  )
    return;
  const request: ConnectorCallInput = {
    connectorId: connector.id,
    catalogVersion: connector.catalogVersion,
    tool: "list_calendars",
    args: {},
  };
  let directory: PreparedConnector;
  try {
    const resolved = local.connectors?.resolveTool(context.botId, request, context.groupId);
    if (!resolved?.tool.readOnly) return;
    directory = resolved;
  } catch (error) {
    signal.throwIfAborted();
    // A missing/revoked directory only loses the display name; it must never create a write draft.
    if (
      error instanceof Error &&
      "code" in error &&
      ["connector_unavailable", "connector_tool_denied", "connector_catalog_changed"].includes(
        String(error.code),
      )
    )
      return;
    throw error;
  }
  // One whole-directory query, never one native call per calendar or an unguarded service call.
  const lookup = await run.runSynthetic(
    {
      id: randomUUID(),
      tool: "connector_call",
      input: { ...request },
    },
    signal,
  );
  signal.throwIfAborted();
  if (lookup.allowed && !lookup.result.isError) {
    // Raw connector calls may lack a capability alias. The exact same-connection read
    // was authorized above; decode its bounded envelope, never a model-provided name.
    let value: unknown;
    try {
      value = JSON.parse(lookup.result.text);
    } catch {
      return;
    }
    local.drafts.calendars.observeDirectory(context, directory, value);
  }
}
