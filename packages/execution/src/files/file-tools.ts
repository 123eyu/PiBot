import { ExecError, type FileContext } from "../core/types.ts";
import { applyPatch } from "./apply-patch.ts";
import { editFile, listDir, readFile, writeFile } from "./files.ts";
import { recoverPatches } from "./patch-journal.ts";
import { PatchRecoveryError } from "./patch-publish.ts";
import { findFiles, searchText } from "./search-files.ts";
import type { SearchEngine } from "./search-rg.ts";

/** `AbortSignal.timeout` rejects with a DOMException, so the name is the only stable marker. */
function deadlineExpired(error: unknown) {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function fileError(
  error: unknown,
  caller?: AbortSignal,
  timeoutCode: "timeout" | "write_timeout" = "timeout",
): ExecError {
  if (error instanceof ExecError) return error;
  // A caller stop stays an abort; only a deadline that fired while the caller was still waiting is
  // a timeout, so the model narrows the request instead of retrying it blindly. Writes get
  // their own code because a write that timed out may already be partly applied.
  if (caller && !caller.aborted && deadlineExpired(error)) return new ExecError(timeoutCode);
  // Keep only stable filesystem categories; raw errors can contain private paths.
  const codes = new Map<string, ExecError["code"]>([
    ["ENOENT", "file_not_found"],
    ["ENOTDIR", "file_not_directory"],
    ["EACCES", "file_access_denied"],
    ["EPERM", "file_access_denied"],
  ]);
  const code = error instanceof Error && "code" in error ? String(error.code) : "";
  return new ExecError(codes.get(code) ?? "file_failed");
}

/** A shared writer also handles case-insensitive filesystems without guessing their filename identity. */
export function createFileTools(options?: {
  journalDir: string;
  recovered?(count: number): void;
  /** Only the local target supplies one; without it both searches stay on the JS walk. */
  searchEngine?: SearchEngine;
}) {
  const engine = options?.searchEngine;
  let writing = false;
  let recoveryRequired = false;
  async function mutate<T>(operation: () => Promise<T>, context: FileContext): Promise<T> {
    const signal = context.signal;
    if (recoveryRequired) throw new PatchRecoveryError();
    if (writing) throw new ExecError("busy");
    writing = true;
    try {
      if (options) {
        const recoverySignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
        let count: number;
        try {
          count = await recoverPatches(options.journalDir, recoverySignal, context);
        } catch (error) {
          if (signal.aborted) throw error;
          throw new PatchRecoveryError();
        }
        if (count) options.recovered?.(count);
      }
      return await operation();
    } catch (error) {
      if (error instanceof PatchRecoveryError) recoveryRequired = true;
      throw fileError(error, signal, "write_timeout");
    } finally {
      writing = false;
    }
  }
  async function safeRead<T>(operation: () => Promise<T>, caller: AbortSignal) {
    try {
      return await operation();
    } catch (error) {
      throw fileError(error, caller);
    }
  }
  return {
    listDir: (options: Parameters<typeof listDir>[0]) =>
      safeRead(() => listDir(options), options.signal),
    readFile: (options: Parameters<typeof readFile>[0]) =>
      safeRead(() => readFile(options), options.signal),
    // The engine is the target's own, never something a caller's arguments can choose.
    findFiles: (options: Omit<Parameters<typeof findFiles>[0], "engine">) =>
      safeRead(() => findFiles({ ...options, engine }), options.signal),
    searchText: (options: Omit<Parameters<typeof searchText>[0], "engine">) =>
      safeRead(() => searchText({ ...options, engine }), options.signal),
    writeFile: (options: Parameters<typeof writeFile>[0]) =>
      mutate(() => writeFile(options), options),
    applyPatch: (input: Omit<Parameters<typeof applyPatch>[0], "journalDir">) => {
      if (!options) throw new ExecError("invalid_input");
      return mutate(() => applyPatch({ ...input, journalDir: options.journalDir }), input);
    },
    editFile: (options: Parameters<typeof editFile>[0]) => mutate(() => editFile(options), options),
  };
}
