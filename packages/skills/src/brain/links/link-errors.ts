import { PublicDownloadError } from "@pibot/execution";
import { RpcError, RpcErrorCodes } from "@pibot/skills-contract/full";
import { importError } from "../service/skill-import.ts";

export const linkError = (reason: string) => new RpcError(RpcErrorCodes.unsupported, reason);

/** Raw network/filesystem/abort messages can carry untrusted or sensitive text. */
export function linkFailure(error: unknown, signal: AbortSignal): RpcError {
  if (
    signal.aborted ||
    (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
  ) {
    const reason = signal.aborted ? signal.reason : error;
    const timeout = reason instanceof Error && reason.name === "TimeoutError";
    return new RpcError(
      timeout ? RpcErrorCodes.timeout : RpcErrorCodes.closed,
      timeout ? "skill_link_timeout" : "skill_link_cancelled",
    );
  }
  if (error instanceof RpcError) return error;
  if (error instanceof PublicDownloadError) return linkError(`skill_link_${error.reason}`);
  try {
    importError(error);
  } catch (mapped) {
    if (mapped instanceof RpcError) return mapped;
  }
  return linkError("skill_link_download_failed");
}
