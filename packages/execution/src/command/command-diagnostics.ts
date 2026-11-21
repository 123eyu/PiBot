import { type CommandDiagnostic, ExecError, type ExecOptions } from "../core/types.ts";

const filesystemCodes = new Set([
  "ENOENT",
  "ENOTDIR",
  "EACCES",
  "EPERM",
  "EMFILE",
  "ENFILE",
  "ELOOP",
  "EBADF",
  "EIO",
  "ENOSPC",
  "ESTALE",
  "ABORT_ERR",
]);
/** Raw OS errors may contain command arguments or paths; report only fixed stage/code metadata. */
export function commandFailure(
  options: ExecOptions,
  context: Omit<CommandDiagnostic, "code">,
  error: unknown,
) {
  const raw = error instanceof Error && "code" in error ? error.code : undefined;
  const code =
    error instanceof ExecError
      ? error.code
      : typeof raw === "string" && filesystemCodes.has(raw)
        ? raw
        : "unclassified";
  try {
    options.onDiagnostic?.({
      ...context,
      code,
      ...(error instanceof ExecError && error.reason ? { reason: error.reason } : {}),
      ...(error instanceof ExecError && error.profileWriteRoot
        ? {
            profileWriteRootIndex: error.profileWriteRoot.index,
            profileWriteRootKind: error.profileWriteRoot.kind,
          }
        : {}),
    });
  } catch {
    // A diagnostic sink must never replace the original failure or alter cleanup ownership.
  }
}
