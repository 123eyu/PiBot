import type { ManagedResourceKey } from "@pibot/i18n";

const errors = {
  managed_exclude_unsafe: "errors.managed_exclude_unsafe",
  managed_git_config_unsafe: "errors.managed_git_config_unsafe",
  managed_git_config_unavailable: "errors.managed_git_config_unavailable",
  managed_git_layout_unsupported: "errors.managed_git_layout_unsupported",
  managed_resource_busy: "errors.managed_resource_busy",
  managed_background_running: "errors.managed_background_running",
  managed_browser_busy: "errors.managed_resource_busy",
  worktree_busy: "errors.managed_resource_busy",
  managed_files_changed: "errors.managed_files_changed",
  managed_path_changed: "errors.managed_path_changed",
  managed_path_unavailable: "errors.managed_path_unavailable",
  managed_git_unavailable: "errors.managed_git_unavailable",
  managed_git_failed: "errors.managed_git_failed",
  managed_platform_unsupported: "errors.managed_platform_unsupported",
  worktree_creation_missing: "errors.worktree_creation_missing",
  worktree_dirty: "errors.worktree_dirty",
  worktree_diverged: "errors.worktree_diverged",
  worktree_stale: "errors.worktree_stale",
  worktree_identity_changed: "errors.managed_path_changed",
  worktree_source_scope: "errors.worktree_source_scope",
  worktree_bound: "errors.worktree_bound",
  worktree_integrated_binding_pending: "errors.worktree_integrated_binding_pending",
  worktree_integrated_cleanup_pending: "errors.worktree_integrated_cleanup_pending",
  worktree_unmerged_or_dirty: "errors.worktree_unmerged_or_dirty",
  managed_plan_readonly: "errors.managed_plan_readonly",
  managed_plan_step_merge: "errors.managed_plan_step_merge",
  managed_permission_never: "errors.managed_permission_never",
  managed_policy_denied: "errors.managed_permission_never",
} as const satisfies Record<string, ManagedResourceKey>;

/** Only public reason codes become copy; raw RPC messages may contain untrusted details. */
export function managedResourceErrorKey(error: unknown): ManagedResourceKey {
  const code = error instanceof Error ? error.message : "";
  return Object.hasOwn(errors, code) ? errors[code as keyof typeof errors] : "managed.error";
}
