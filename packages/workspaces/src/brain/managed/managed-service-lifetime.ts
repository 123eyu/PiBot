import { ExecError, ManagedExecError } from "@pibot/execution";
import { RpcError, RpcErrorCodes } from "@pibot/workspaces-contract/full";

function publicError(error: unknown): never {
  if (error instanceof ExecError && error.reason !== "cleanup_failed") {
    const reasons: Partial<Record<ExecError["code"], string>> = {
      invalid_input: "managed_invalid_operation",
      outside_workplace: "managed_path_changed",
      isolation_unavailable: "managed_platform_unsupported",
      busy: "managed_resource_busy",
      file_conflict: "managed_files_changed",
      git_unavailable: "managed_git_unavailable",
      command_failed: "managed_git_failed",
    };
    const reason = error instanceof ManagedExecError ? error.managedCode : reasons[error.code];
    if (reason)
      throw new RpcError(
        reason === "managed_platform_unsupported" ||
          reason === "checkpoint_cross_device" ||
          reason === "checkpoint_hardlink_unsupported"
          ? RpcErrorCodes.unsupported
          : error.code === "busy"
            ? RpcErrorCodes.busy
            : RpcErrorCodes.invalidParams,
        reason,
      );
  }
  if (
    error instanceof Error &&
    "code" in error &&
    ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "EXDEV"].includes(String(error.code))
  )
    throw new RpcError(
      error.code === "EXDEV" ? RpcErrorCodes.unsupported : RpcErrorCodes.invalidParams,
      error.code === "EXDEV" ? "checkpoint_cross_device" : "managed_path_unavailable",
    );
  throw error;
}

/** Shutdown waits for the whole operation, including its journal/DB settlement after SRT exits. */
export class ManagedServiceLifetime {
  private readonly controller = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  private uncertain: unknown;
  run<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const joined = AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(120_000)]);
    const pending = Promise.resolve()
      .then(() => {
        joined.throwIfAborted();
        return operation(joined);
      })
      .catch(publicError);
    this.active.add(pending);
    void pending.catch((error) => {
      if (error && typeof error === "object" && error.reason === "cleanup_failed")
        this.uncertain = error;
    });
    void pending
      .finally(() => this.active.delete(pending))
      .catch(() => {
        /* The returned promise retains the failure for its owner. */
      });
    return pending;
  }
  async dispose() {
    this.controller.abort();
    const settled = await Promise.allSettled([...this.active]);
    const uncertain = settled.find(
      (result) =>
        result.status === "rejected" &&
        result.reason &&
        typeof result.reason === "object" &&
        result.reason.reason === "cleanup_failed",
    );
    if (uncertain?.status === "rejected") throw uncertain.reason;
    if (this.uncertain) throw this.uncertain;
  }
}
