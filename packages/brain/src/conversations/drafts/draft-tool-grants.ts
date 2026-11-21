import {
  connectionWriteRememberable,
  effectiveConfirmationMode,
  matchesGrant,
} from "@pibot/policy";
import type { ConnectorTool, DraftView, GrantScope } from "@pibot/protocol-base";
import { RpcError } from "@pibot/protocol-base";
import type { DraftPayload } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import { runPermissions } from "../../core/run-permissions.ts";
import type { LocalService } from "../../local-service.ts";
import type { BrowserRunScope } from "../../runtime/browser/port.ts";
import {
  type ConnectorCallInput,
  ConnectorToolError,
  connectorDigest,
} from "../../runtime/tools/connectors/connector-tools.ts";
import { snapshot } from "./draft-content.ts";

export function connectionToolScope(connectorId: string, tool: ConnectorTool): GrantScope {
  return {
    kind: "connector_tool",
    connectorId,
    tool: tool.tool,
    definitionDigest: connectorDigest([
      tool.description,
      tool.schema,
      tool.readOnlyHint ?? null,
      tool.idempotentHint ?? null,
      tool.destructiveHint ?? null,
    ]),
  };
}

/**
 * "always do this" exists only where the connection's mode lets anything other than
 * the person's answer authorize a write; "ask every time" and "read only" always win over it.
 */
export function connectionToolRememberable(local: LocalService, connectorId: string) {
  const connector = local.connectors?.get(connectorId);
  if (!local.connectors || !connector) return false;
  return connectionWriteRememberable(
    effectiveConfirmationMode({ connector, access: local.connectors.access(connectorId) }),
  );
}

/** Reusable tool consent; user-identity sends still require their own per-call confirmation. */
export function hasRememberedConnectionTool(
  local: LocalService,
  botId: string,
  connectorId: string,
  tool: ConnectorTool,
  context?: BrowserRunScope,
) {
  if (!connectionToolRememberable(local, connectorId)) return false;
  const scope = connectionToolScope(connectorId, tool);
  return local
    .grants(botId, context)
    .some(
      (grant) =>
        !grant.revokedAt &&
        matchesGrant(grant, { botId, category: "connector", scope }, local.deps.platform),
    );
}

/** Persist only a still-current user decision after a confirmed successful write. */
export function rememberConnectionTool(
  local: LocalService,
  currentContext: () => ToolRunContext,
  view: DraftView,
  payload: DraftPayload,
  call: ConnectorCallInput,
): boolean {
  const service = local.connectors;
  if (!service || !connectionToolRememberable(local, view.draft.connectorId)) return false;
  try {
    const context = currentContext();
    const levels = local.tasks.settings(context, runPermissions(local, context)).levels;
    if (levels.connector === "never" || levels.send_out === "never") return false;
    const live = service.resolveTool(
      view.botId,
      call,
      context.permissionGroupId ?? context.groupId,
    );
    if (snapshot(live) !== payload.snapshotDigest) return false;
    if (local.deps.redactor.redact(live.tool.tool) !== live.tool.tool) return false;
    const scope = connectionToolScope(view.draft.connectorId, live.tool);
    const groupId = context.permissionGroupId ?? context.groupId;
    // Runs inside the settlement transaction, so the lookup and the insert cannot interleave
    // with another draft remembering the same tool.
    if (
      scope.kind === "connector_tool" &&
      local.approvals.grants.activeConnectorTool({
        botId: view.botId,
        ...(groupId ? { groupId } : {}),
        connectorId: scope.connectorId,
        tool: scope.tool,
        definitionDigest: scope.definitionDigest,
      })
    )
      return true;
    const grant = local.approvals.grants.create({
      botId: view.botId,
      category: "connector",
      scope,
      ...(groupId ? { groupId } : {}),
    });
    local.approvals.audit.append({
      botId: view.botId,
      runId: context.runId,
      kind: "grant.created",
      summary: "Connection tool permission remembered / 已记住连接工具授权",
      detail: { grantId: grant.id, connectorId: view.draft.connectorId, actor: "user" },
    });
    return true;
  } catch (error) {
    // A concurrent disconnect/revocation must not turn a completed send into a retryable failure.
    if (!(error instanceof ConnectorToolError || error instanceof RpcError)) throw error;
    local.deps.logger.warn(JSON.stringify({ module: "drafts", event: "tool_grant_not_saved" }));
    return false;
  }
}
