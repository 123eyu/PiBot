import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { MobileKey } from "../../i18n/messages.ts";
import { errorKey } from "../../runtime/errors.ts";

const reasons: Record<string, MobileKey> = {
  preview_missing: "fileMissing",
  preview_changed: "fileChanged",
  office_changed: "fileChanged",
  changes_stale: "fileChanged",
  preview_unsupported: "fileUnsupported",
  preview_encoding: "fileUnsupported",
  office_invalid: "fileUnsupported",
  office_attachment_unavailable: "fileUnsupported",
  preview_limit: "fileTooLarge",
  remote_response_too_large: "fileTooLarge",
};
/** Preview-specific wording for the computer's expected refusals; everything else as usual. */
export function fileErrorKey(error: unknown): MobileKey {
  if (error instanceof RpcError) {
    const known = reasons[error.message];
    if (known && (error.code === RpcErrorCodes.invalidParams || known === "fileTooLarge"))
      return known;
  }
  if (error instanceof Error && error.message === "offline") return "fileOffline";
  return errorKey(error);
}
