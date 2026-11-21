import { ExecError } from "../core/types.ts";

export class ManagedExecError extends ExecError {
  constructor(
    readonly managedCode:
      | "managed_git_config_unsafe"
      | "managed_git_layout_unsupported"
      | "managed_git_config_unavailable"
      | "managed_exclude_unsafe"
      | "checkpoint_hardlink_unsupported"
      | "checkpoint_cross_device"
      | "checkpoint_recovery_unavailable",
  ) {
    super("invalid_input");
  }
}
