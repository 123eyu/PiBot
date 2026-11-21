import { createHash } from "node:crypto";
import {
  CalendarDraftContentSchema,
  DraftContentSchema,
  type DraftMetadata,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import type { Redactor } from "@pibot/secrets";
import type { DraftPayload } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import {
  type ConnectorCallInput,
  connectorDigest,
  type PreparedConnector,
} from "../../runtime/tools/connectors/connector-tools.ts";
import { canonicalValue } from "../../runtime/tools/journal/journal-outcome.ts";
import { calendarTimes } from "./calendar-time.ts";
export const contentDigest = (text: string) => createHash("sha256").update(text).digest("hex");
export const snapshot = ({ argsDigest: _args, ...prepared }: PreparedConnector) =>
  connectorDigest(prepared);
/** Drafts and the execution journal share one canonical form (key-sorted JSON). */
export const canonicalDraftValue = canonicalValue;
export const fail = (code: keyof typeof RpcErrorCodes, message: string): never => {
  throw new RpcError(RpcErrorCodes[code], message);
};

function bindingTarget(
  template: string,
  args: ConnectorCallInput["args"],
  properties: Record<string, unknown>,
): string | undefined {
  let valid = true;
  const target = template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_placeholder, field) => {
    const value = args[field];
    const fieldSchema = properties[field];
    const type =
      fieldSchema && typeof fieldSchema === "object" && !Array.isArray(fieldSchema)
        ? (fieldSchema as Record<string, unknown>).type
        : undefined;
    // The value must match its declared type, so an integer field never renders arbitrary text.
    const matches =
      type === "string"
        ? typeof value === "string"
        : type === "integer"
          ? typeof value === "number" && Number.isSafeInteger(value)
          : type === "number"
            ? typeof value === "number" && Number.isFinite(value)
            : false;
    if (!matches) {
      valid = false;
      return "";
    }
    return String(value);
  });
  return valid && !/[{}]/.test(target) && target.length > 0 && target.length <= 4096
    ? target
    : undefined;
}

export function makeDraft(
  prepared: PreparedConnector,
  input: ConnectorCallInput,
  context: ToolRunContext,
  redactor: Redactor,
): { draft: DraftMetadata; payload: DraftPayload } {
  const calendarCreate =
    prepared.tool.capabilityId === "calendar" &&
    prepared.tool.capabilityTool === "calendar_create_event" &&
    prepared.tool.tool === "create_event";
  const times = calendarCreate ? calendarTimes(input.args) : undefined;
  if (times) input = { ...input, args: { ...input.args, start: times.start, end: times.end } };
  if (calendarCreate && !CalendarDraftContentSchema.safeParse(input.args).success)
    return fail("draftContentInvalid", "calendar_content_invalid");
  const binding = prepared.tool.draftBinding;
  let content = JSON.stringify(input.args);
  // Unbound MCP tools have no declared recipient; show only conventional routing fields,
  // never dump arbitrary arguments (which may contain the message itself).
  const route = ["target", "board", "boardName", "channel", "recipient", "to"]
    .map((key) => input.args[key])
    .find(
      (value): value is string =>
        typeof value === "string" && value.length > 0 && value.length <= 200,
    );
  let target = `${prepared.tool.tool}${route ? ` · ${route}` : ""}`;
  let contentField: string | null = null;
  if (binding) {
    const body = input.args[binding.contentField],
      destination = input.args[binding.targetField];
    const properties = prepared.tool.schema.properties;
    if (
      typeof body !== "string" ||
      typeof destination !== "string" ||
      !destination ||
      destination.length > 4096 ||
      !properties ||
      Array.isArray(properties) ||
      typeof properties !== "object"
    )
      return fail("draftContentInvalid", "draft_binding_invalid");
    const bodySchema = properties[binding.contentField],
      targetSchema = properties[binding.targetField];
    if (
      !bodySchema ||
      typeof bodySchema !== "object" ||
      Array.isArray(bodySchema) ||
      bodySchema.type !== "string" ||
      !targetSchema ||
      typeof targetSchema !== "object" ||
      Array.isArray(targetSchema) ||
      targetSchema.type !== "string"
    )
      return fail("draftContentInvalid", "draft_binding_invalid");
    content = body;
    target = binding.targetTemplate
      ? (bindingTarget(binding.targetTemplate, input.args, properties) ??
        fail("draftContentInvalid", "draft_binding_invalid"))
      : destination;
    contentField = binding.contentField;
  }
  if (!DraftContentSchema.safeParse(content).success)
    return fail("draftContentInvalid", "draft_content_invalid");
  const immutable = { ...input.args };
  if (contentField !== null) delete immutable[contentField];
  const payload: DraftPayload = {
    args: contentField === null ? input.args : immutable,
    content,
    contentField,
    snapshotDigest: snapshot(prepared),
    definitionDigest: connectorDefinitionDigest(prepared),
    targetDigest: connectorDigest(canonicalDraftValue(immutable)),
    ...(times ? { calendarPresentation: { timeZone: times.timeZone } } : {}),
    ...(context.groupId ? { groupId: context.groupId } : {}),
  };
  const draft: DraftMetadata = {
    identity: prepared.connector.identity,
    connectorName: redactor.redact(prepared.connector.name).slice(0, 200),
    target: redactor.redact(target).slice(0, 4096),
    connectorId: prepared.connector.id,
    tool: prepared.tool.tool,
    revision: prepared.connector.revision,
    catalogVersion: prepared.connector.catalogVersion,
    contentDigest: contentDigest(content),
    contentLength: Buffer.byteLength(content, "utf8"),
    ...(calendarCreate && CalendarDraftContentSchema.safeParse(input.args).success
      ? { operation: "calendar_create" as const }
      : {}),
    editable: contentField !== null,
    canRememberTarget:
      prepared.connector.identity === "bot" &&
      contentField !== null &&
      context.routineSource !== "trial",
  };

  return { draft, payload };
}

export const draftCallDigest = (call: { tool: string; input: unknown }) =>
  connectorDigest(canonicalDraftValue({ tool: call.tool, input: call.input }));

export const connectorDefinitionDigest = (
  prepared: Pick<PreparedConnector, "tool" | "connector" | "pluginDigest">,
) =>
  connectorDigest({
    tool: prepared.tool.tool,
    schema: prepared.tool.schema,
    description: prepared.tool.description,
    binding: prepared.tool.draftBinding,
    identity: prepared.connector.identity,
    pluginDigest: prepared.pluginDigest,
    revision: prepared.connector.revision,
    catalogVersion: prepared.connector.catalogVersion,
  });
