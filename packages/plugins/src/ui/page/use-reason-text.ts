import type { TranslationKey } from "@pibot/i18n";

/**
 * Words for every reason code the recent-use list can carry, so the person never reads
 * a raw code. Existing texts are reused (connection failures, the audit page's block reasons,
 * policy explanations); only codes without any text got new keys. Sources: read failures
 * (`connector-tools.ts` ConnectorToolError codes), refusals (`auditBlockReason` and policy
 * reasons) and send-draft states (`connection-activity.ts`).
 */
const reasonKeys: Record<string, TranslationKey> = {
  // Read call failures.
  connector_unavailable: "policy.reason.connector_unavailable",
  connector_catalog_changed: "connectors.failure.catalog_changed",
  connector_tool_denied: "connectors.failure.tool_denied",
  connector_args_invalid: "connectors.failure.invalid_arguments",
  connector_context_denied: "policy.reason.plan_readonly",
  connector_schema_unsupported: "connectors.useReason.schema_unsupported",
  connector_draft_resolved: "connectors.useReason.draft_resolved",
  connector_secret_denied: "connectors.useReason.secret_denied",
  connector_call_failed: "connectors.useReason.call_failed",
  capability_served_elsewhere: "connectors.useReason.served_elsewhere",
  connector_auth_required: "connectors.useReason.auth_required",
  // Refusals by policy, approval or the run.
  connector_read_only_mode: "policy.reason.connector_read_only_mode",
  connector_confirmation_required: "policy.reason.connector_confirmation_required",
  outside_workplace_send_denied: "audit.reason.sendOutside",
  outside_workplace_write_denied: "audit.reason.outside",
  protected_path: "audit.reason.protected",
  privilege_escalation_denied: "audit.reason.privilege",
  local_network_denied: "audit.reason.privateNetwork",
  domain_not_allowed: "audit.reason.network",
  permission_never: "audit.reason.permission",
  category_unavailable: "audit.reason.unsupported",
  path_or_url_unresolved: "audit.reason.path",
  changed: "audit.reason.changed",
  search_disclosure_required: "audit.reason.disclosure",
  approval_denied_or_expired: "audit.reason.approval",
  stopped: "audit.reason.stopped",
  invalid_input: "audit.reason.input",
  invalid_tool_input: "policy.reason.invalid_tool_input",
  collaboration_unavailable: "audit.reason.collaboration",
  not_authorized: "audit.reason.unauthorized",
  tool_authorization_refused: "policy.reason.tool_authorization_refused",
  policy_denied: "audit.reason.generic",
  // Send drafts.
  draft_expired: "connectors.useReason.draft_expired",
  draft_failed: "connectors.useReason.draft_failed",
  draft_unknown: "connectors.useReason.draft_unknown",
};

export function connectionUseReasonKey(code: string): TranslationKey | undefined {
  return Object.hasOwn(reasonKeys, code) ? reasonKeys[code] : undefined;
}
