import { RpcError, RpcErrorCodes } from "@pibot/protocol";
import type { RequestError } from "../chat/types.ts";

const known = new Map<number, RequestError>([
  [RpcErrorCodes.busy, "busy"],
  [RpcErrorCodes.noModel, "no_model"],
  [RpcErrorCodes.invalidParams, "internal"],
  [RpcErrorCodes.imageUnsupported, "image_unsupported"],
  [RpcErrorCodes.attachmentInvalid, "attachment_invalid"],
  [RpcErrorCodes.scannedPdfUnsupported, "scanned_pdf_unsupported"],
  [RpcErrorCodes.attachmentConversion, "attachment_conversion"],
  [RpcErrorCodes.mentionUnresolved, "mention_unresolved"],
]);
export function groupRequestError(error: unknown): RequestError {
  if (
    error instanceof RpcError &&
    ["group_topic_folder_expired", "workspace_conflict"].includes(error.message)
  )
    return "workplace_unavailable";
  if (error instanceof RpcError && error.message === "message_quote_unavailable")
    return "quote_unavailable";
  // A new topic waits for the group's running tasks, background commands and pending cards; the
  // generic "queue is full" text named none of that (docs guide 2026-11-14).
  if (error instanceof RpcError && error.message === "group_topic_busy") return "topic_busy";
  return error instanceof RpcError ? (known.get(error.code) ?? "uncertain") : "uncertain";
}
