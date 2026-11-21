import { connectionConfirmation, effectiveConfirmationMode } from "@pibot/policy";
import type { RoutinePreauthInput } from "@pibot/protocol-base";
import { connectorDefinitionDigest } from "../../conversations/drafts/draft-content.ts";
import { hasRememberedConnectionTool } from "../../conversations/drafts/draft-tool-grants.ts";
import type { LocalService } from "../../local-service.ts";

/** Validates live metadata; a saved consent never makes a removed connection visible. */
export function connectorPreauthIssue(
  local: LocalService,
  botId: string,
  op: RoutinePreauthInput,
): "permission_ceiling" | "invalid_scope" | undefined {
  if (op.scope.kind !== "connector" && op.scope.kind !== "send_target") return undefined;
  if (local.permissions.effective(botId).levels.connector === "never") return "permission_ceiling";
  const repo = local.connectors;
  if (!repo) return "invalid_scope";
  const connector = repo.get(op.scope.connectorId);
  const plugin = connector ? repo.plugin(connector.pluginInstallationId) : undefined;
  if (
    !connector ||
    !plugin?.enabled ||
    plugin.status !== "installed" ||
    !connector.enabled ||
    !["ready", "idle"].includes(connector.status)
  )
    return "invalid_scope";
  const access = repo.access(connector.id);
  if (access.mode === "selected" && !access.bots.includes(botId)) return "invalid_scope";
  const confirmation = connectionConfirmation(
    effectiveConfirmationMode({ connector, access }),
    op.scope.kind === "send_target",
  );
  if (confirmation === "ask_now") return "invalid_scope";
  if (op.scope.kind === "connector") return undefined;
  if (confirmation === "blocked") return "permission_ceiling";
  const tool = repo.tool(connector.id, connector.catalogVersion, op.scope.tool);
  if (
    (connector.identity !== "bot" &&
      (!tool || !hasRememberedConnectionTool(local, botId, connector.id, tool))) ||
    !tool?.enabled ||
    tool.readOnly ||
    !tool.draftBinding ||
    connectorDefinitionDigest({ connector, tool, pluginDigest: plugin.digest }) !==
      op.scope.definitionDigest
  )
    return "invalid_scope";
  return undefined;
}
