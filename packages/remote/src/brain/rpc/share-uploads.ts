import { createHash, randomUUID } from "node:crypto";
import {
  type AttachmentInput,
  AttachmentInputSchema,
  fileMime,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";
import type { RemoteShareReceipt, RemoteShareUpload } from "@pibot/remote-contract";

interface Upload {
  kind: "image" | "file";
  name: string;
  mimeType: string;
  total: number;
  parts: string[];
  received: number;
  at: number;
  done?: { input: AttachmentInput; digest: string };
}
// A message carries at most 5 attachments; one more slot lets a retry upload while the old copy
// waits out its TTL. The byte budget bounds desktop memory per phone session (base64 characters).
const SLOTS = 6;
const BUDGET = 48 * 1024 * 1024;
const TTL_MS = 10 * 60_000;
const invalid = (reason: string): never => {
  throw new RpcError(RpcErrorCodes.attachmentInvalid, reason);
};

/**
 * Files a phone shares into a conversation, received in frame-sized slices and held
 * in memory for this phone session only. They become attachments when this session's chat.send
 * names them: the kernel then validates and stores them exactly like a desktop attachment, so
 * the size, type and image checks are the desktop's own. Nothing here touches the disk.
 */
export function shareUploads() {
  const uploads = new Map<string, Upload>();
  const used = () => [...uploads.values()].reduce((sum, upload) => sum + upload.received, 0);
  const prune = (now: number) => {
    for (const [id, upload] of uploads) if (now - upload.at > TTL_MS) uploads.delete(id);
  };
  function start(input: RemoteShareUpload): [string, Upload] {
    if (input.kind === "file" && fileMime(input.name) !== input.mimeType)
      invalid("remote_share_type");
    if (uploads.size >= SLOTS) throw new RpcError(RpcErrorCodes.busy, "remote_share_capacity");
    const upload: Upload = {
      kind: input.kind,
      name: input.name,
      mimeType: input.mimeType,
      total: input.total,
      parts: [],
      received: 0,
      at: Date.now(),
    };
    const id = randomUUID();
    uploads.set(id, upload);
    return [id, upload];
  }
  return {
    receive(input: RemoteShareUpload): RemoteShareReceipt {
      prune(Date.now());
      const [id, upload] = input.uploadId
        ? [input.uploadId, uploads.get(input.uploadId) ?? invalid("remote_share_expired")]
        : start(input);
      if (
        upload.done ||
        input.offset !== upload.received ||
        input.total !== upload.total ||
        input.kind !== upload.kind ||
        input.name !== upload.name ||
        input.mimeType !== upload.mimeType ||
        upload.received + input.chunk.length > upload.total
      )
        invalid("remote_share_sequence");
      const last = upload.received + input.chunk.length === upload.total;
      // Every slice but the last decodes on its own, so a cut never lands inside a quantum.
      if (!last && input.chunk.length % 4 !== 0) invalid("remote_share_sequence");
      if (used() + input.chunk.length > BUDGET)
        throw new RpcError(RpcErrorCodes.busy, "remote_share_capacity");
      upload.parts.push(input.chunk);
      upload.received += input.chunk.length;
      upload.at = Date.now();
      if (!last) return { uploadId: id, received: upload.received };
      const data = upload.parts.join("");
      upload.parts = [data];
      const parsed = AttachmentInputSchema.safeParse({
        kind: upload.kind,
        name: upload.name,
        mimeType: upload.mimeType,
        data,
      });
      if (!parsed.success) {
        uploads.delete(id);
        invalid("remote_share_invalid");
      }
      upload.done = {
        input: parsed.data as AttachmentInput,
        // Same bytes and name re-uploaded after a lost acknowledgement fingerprint the same.
        digest: createHash("sha256")
          .update(`${upload.kind}\0${upload.name}\0${upload.mimeType}\0`)
          .update(data)
          .digest("hex"),
      };
      return { uploadId: id, received: upload.received, attachmentId: id };
    },
    /** The finished uploads a chat.send names, in order; unknown or unfinished IDs refuse it. */
    take(ids: readonly string[]) {
      prune(Date.now());
      if (new Set(ids).size !== ids.length) invalid("remote_attachment_unavailable");
      return ids.map((id) => {
        const done = uploads.get(id)?.done;
        if (!done) throw new RpcError(RpcErrorCodes.invalidParams, "remote_attachment_unavailable");
        return done;
      });
    },
    release(ids: readonly string[]) {
      for (const id of ids) uploads.delete(id);
    },
    clear() {
      uploads.clear();
    },
  };
}
