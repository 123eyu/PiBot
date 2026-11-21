import type { createTranslator, TranslationKey } from "@pibot/i18n";
import { isolationReasonText } from "@pibot/i18n";
import { type ApprovalFact, CHAT_SEARCH_TARGET } from "@pibot/protocol";

export { isolationReasonText };

const warnings: Record<string, TranslationKey> = {
  command_network_confirmation: "policy.reason.command_network_confirmation",
  command_install_confirmation: "policy.reason.command_install_confirmation",
  command_background_confirmation: "policy.reason.command_background_confirmation",
  host_ssh_static_identity: "facts.value.host_ssh_static_identity",
  git_configuration_project_setter: "facts.value.git_configuration_project_setter",
  git_configuration_global_setter: "facts.value.git_configuration_global_setter",
  git_configuration_sensitive_project_setter:
    "facts.value.git_configuration_sensitive_project_setter",
  git_entry_once: "facts.value.git_entry_once",
  readonly: "facts.value.readonly",
  topic_writable_scope: "facts.value.topic_writable_scope",
  incomplete_analysis: "facts.value.incomplete_analysis",
  windows_unisolated: "facts.value.windows_unisolated",
  outside_sandbox: "facts.value.outside_sandbox",
  outside_sandbox_login: "facts.value.outside_sandbox_login",
  system_service: "facts.value.system_service",
  local_service: "facts.value.local_service",
  sandbox_outside_auto: "permissions.sandboxAutoOutside",
  acp_editor_terminal_unisolated: "facts.value.acp_editor_terminal_unisolated",
  outside_delete: "facts.value.outside_delete",
  protected_command_path: "facts.value.protected_command_path",
  outside_workplace_write: "facts.value.outside_workplace_write",
  // Policy already explained these two codes, but the card fell back to the generic
  // "impact cannot be fully determined" text, so the specific wording never reached the user.
  unknown_command_directory: "facts.value.unknown_command_directory",
  unknown_command_directory_sandboxed: "facts.value.unknown_command_directory_sandboxed",
  outside_permissions: "facts.value.outside_permissions",
  remove_workplace_root: "facts.value.remove_workplace_root",
  system_settings: "facts.value.system_settings",
  force_push: "facts.value.force_push",
  hard_remote_reset: "facts.value.hard_remote_reset",
  shutdown: "facts.value.shutdown",
  kill_init: "facts.value.kill_init",
  killall_without_target: "facts.value.killall_without_target",
  download_and_execute: "facts.value.download_and_execute",
  docker_access: "facts.value.docker_access",
  docker_unisolated: "facts.value.docker_unisolated",
  background_command: "facts.value.background_command",
  background_stdin: "facts.value.background_stdin",
};

export function approvalFactText(fact: ApprovalFact, t: ReturnType<typeof createTranslator>) {
  if (fact.value === "readable_conversations") return t("facts.value.readableConversations");
  // A script judged by its content is named by that content's digest internally.
  if (fact.kind === "program" && /^script:[0-9a-f]+$/.test(fact.value))
    return t("facts.value.scriptByContent");
  if (fact.value === CHAT_SEARCH_TARGET) return t("facts.value.currentChatHistory");
  if (fact.kind === "network" && fact.value === "network_target_unknown")
    return t("facts.value.network_target_unknown");
  if (fact.kind === "warning") {
    const key = Object.hasOwn(warnings, fact.value) ? warnings[fact.value] : undefined;
    if (key) return t(key);
    // Preserve already translated prose; a future internal warning must not appear as code.
    if (/^[a-z]+(?:_[a-z]+)+$/.test(fact.value)) return t("facts.value.unknownWarning");
  }
  return fact.value;
}

/**
 * Remaining time on an approval card. Routine approvals wait up to a day (chat ones 10 minutes),
 * so hours are shown instead of "1439:42".
 */
export function approvalCountdown(seconds: number) {
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
