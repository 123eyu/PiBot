import { createHash } from "node:crypto";
import { type KernelMethodResults, previewKind, RpcError } from "@pibot/protocol-base";
import { checkedImage, imageMime } from "../../conversations/attachments/attachment-files.ts";
import type { WorkspaceFileAccess } from "../workplaces/workspace-files.ts";

export interface GroupFileCursor {
  root: string;
  directory: string;
  path: string;
  offset: number;
}
export async function remoteGroupPage(
  files: WorkspaceFileAccess,
  token: string,
  path: string,
  relative: string,
  limit: number,
  before: GroupFileCursor | undefined,
  encode: (cursor: GroupFileCursor) => string,
  signal: AbortSignal,
): Promise<KernelMethodResults["groups.files.list"]> {
  if (before && (before.root !== token || before.path !== relative))
    throw new RpcError(-32602, "Group file location changed or unavailable");
  const page = await files.page(path, signal, before?.offset, before?.directory, limit);
  const entries = page.entries
    .filter((e) => !/[\\:\p{Cc}\p{Cf}]/u.test(e.name))
    .map((e) => ({ name: e.name, path: relative ? `${relative}/${e.name}` : e.name, kind: e.kind }))
    .filter((e) => e.path.length <= 4096 && e.path.split("/").length <= 32);
  const cursor =
    page.more && page.offset < 10000
      ? encode({ root: token, directory: page.version, path: relative, offset: page.offset })
      : undefined;
  return { entries, rootToken: token, cursor, truncated: page.more && !cursor };
}
/** The caller must recheck group ownership after this read, before publishing bytes. */
export async function remoteGroupPreview(
  files: WorkspaceFileAccess,
  root: string,
  path: string,
  expectedRevision: string | undefined,
  redact: (text: string) => string,
  signal: AbortSignal,
): Promise<KernelMethodResults["groups.files.preview"]> {
  const kind = previewKind(path);
  if (!kind) throw new RpcError(-32602, "preview_unsupported");
  const file = await files.read(root, path, signal, 20 * 1024 * 1024);
  if (!file?.data) throw new RpcError(-32602, "preview_failed");
  const revision = createHash("sha256").update(file.data).digest("hex");
  if (expectedRevision && expectedRevision !== revision)
    throw new RpcError(-32602, "preview_changed");
  if (kind === "markdown" || kind === "code" || kind === "svg") {
    if (file.data.length > 2097152) throw new RpcError(-32602, "preview_limit");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(file.data);
    if (kind === "svg") {
      if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new RpcError(-32602, "preview_unsupported");
    } else return { kind, revision, data: "", text: redact(text) };
  }
  if (kind === "image") checkedImage(file.data.toString("base64"), imageMime(file.data));
  return { kind, revision, data: file.data.toString("base64") };
}
