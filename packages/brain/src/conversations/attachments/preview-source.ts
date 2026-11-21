import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { directoryIdentity, ExecError } from "@pibot/execution";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import type { ChangesPort } from "../../runtime/workspaces/port.ts";
import { attachmentSource } from "./attachment-source.ts";

export interface PreviewSourceFile {
  name: string;
  botId: string;
  root: string;
  path: string;
  rootIdentity: { canonicalPath: string; device: string; inode: string };
  /** Attachments only (an image attachment is never an office file); absent for run changes. */
  attachmentKind?: string;
}
export interface PreviewSourceDeps {
  db: DatabaseSync;
  dataDir: string;
  /** Run changes are recorded by the workspaces capability; absent capability = unsupported. */
  changes(): Pick<ChangesPort, "turnFile">;
}
type SourceInput = { attachmentId: string; messageId: string } | { runId: string; path: string };

/**
 * GUI read authority for previews: a settled message attachment, or a file that a run's own
 * records say it changed. Neither branch ever reads a renderer-supplied path.
 */
export async function previewSource(
  deps: PreviewSourceDeps,
  input: SourceInput,
  signal: AbortSignal,
): Promise<PreviewSourceFile> {
  if ("runId" in input) {
    const file = await deps.changes().turnFile(input.runId, input.path, signal);
    return { ...file, name: basename(file.path) };
  }
  const item = await attachmentSource(deps.db, deps.dataDir, input, signal);
  return {
    name: item.stored.metadata.name,
    botId: item.stored.botId,
    root: item.root,
    path: item.path,
    rootIdentity: await directoryIdentity(item.root),
    attachmentKind: item.stored.metadata.kind,
  };
}

/**
 * Files a Bot wrote into the user's folders keep changing after the run. A file that vanished or
 * was swapped between the source check and the read is an expected preview state, not a bug.
 */
export function previewSourceError(error: unknown): never {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT")
    throw new RpcError(RpcErrorCodes.invalidParams, "preview_missing");
  if (error instanceof ExecError && error.code === "outside_workplace")
    throw new RpcError(RpcErrorCodes.invalidParams, "preview_changed");
  if (error instanceof ExecError && error.code === "file_failed")
    throw new RpcError(RpcErrorCodes.invalidParams, "preview_failed");
  throw error;
}
