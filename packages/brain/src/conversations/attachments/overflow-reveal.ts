import { lstat, realpath } from "node:fs/promises";
import { RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import { MessagesRepo } from "@pibot/storage";
import { abortable } from "../../core/abort.ts";
import type { LocalDependencies } from "../../core/local-types.ts";
import { invalidAttachment } from "./attachment-files.ts";

/**
 * Maintainers 2026-11-20: a reply that produced more files than it may carry says how many were left
 * out and opens their folder. The folder comes from the brain's own record on the message (the
 * renderer only names the message) and must still be a real, unlinked directory.
 */
export async function revealOverflow(
  deps: Pick<LocalDependencies, "db" | "host">,
  messageId: string,
  signal: AbortSignal,
) {
  const show = deps.host.revealPath;
  if (!show) throw new RpcError(RpcErrorCodes.unsupported, "attachment_reveal_unsupported");
  const message = new MessagesRepo(deps.db).get(messageId);
  const usage = message?.usage;
  const record =
    usage && typeof usage === "object" && !Array.isArray(usage)
      ? usage.attachmentOverflow
      : undefined;
  const path =
    message?.role === "assistant" &&
    record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    typeof record.path === "string"
      ? record.path
      : undefined;
  if (!path) invalidAttachment();
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isDirectory() || (await realpath(path).catch(() => undefined)) !== path)
    invalidAttachment();
  signal.throwIfAborted();
  await abortable(show({ path, allowedRoots: [path] }, signal), signal);
  return { ok: true as const };
}
