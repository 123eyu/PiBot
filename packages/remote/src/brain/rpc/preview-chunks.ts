import { randomUUID } from "node:crypto";
import {
  PREVIEW_DATA_CHUNK,
  PREVIEW_TEXT_CHUNK,
  type PreviewFile,
  PreviewFileSchema,
  type RemotePreviewChunk,
  type RemotePreviewRead,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol";

type Dispatch = (method: "preview.read", params: unknown, signal: AbortSignal) => Promise<unknown>;
interface Entry {
  file: PreviewFile;
  at: number;
}
// One phone reads a file slice by slice within seconds; two slots cover a preview replaced by
// the next one, and the TTL bounds how long a ~28 MB result can stay in desktop memory.
const SLOTS = 2;
const TTL_MS = 120_000;

/**
 * Serves remote.preview.read: one kernel preview.read (the same source authority, revision
 * check and redaction as the desktop pane) cut into frame-sized slices. The whole result stays
 * in memory only until its last slice is sent, the TTL passes or the phone session closes.
 */
export function previewChunks(dispatch: Dispatch) {
  const entries = new Map<string, Entry>();
  const prune = (now: number) => {
    for (const [key, entry] of entries) if (now - entry.at > TTL_MS) entries.delete(key);
  };
  async function load(key: string, source: object, signal: AbortSignal, expectedRevision?: string) {
    const file = PreviewFileSchema.parse(
      await dispatch(
        "preview.read",
        {
          ...source,
          requestId: randomUUID(),
          ...(expectedRevision ? { expectedRevision } : {}),
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    entries.delete(key);
    entries.set(key, { file, at: Date.now() });
    for (const old of entries.keys()) if (entries.size > SLOTS) entries.delete(old);
    return file;
  }
  async function current(key: string, source: object, revision: string, signal: AbortSignal) {
    const entry = entries.get(key);
    const known = entry?.file;
    if (entry && known?.revision === revision) {
      entry.at = Date.now();
      return known;
    }
    // Expired or evicted: read again, and fail with preview_changed if the file moved on.
    return load(key, source, signal, revision);
  }
  return {
    async read(input: RemotePreviewRead, signal: AbortSignal): Promise<RemotePreviewChunk> {
      const { revision, cached, offset, ...source } = input;
      const key = JSON.stringify(
        "runId" in source
          ? ["run", source.runId, source.path]
          : ["attachment", source.attachmentId],
      );
      prune(Date.now());
      const file = revision
        ? await current(key, source, revision, signal)
        : await load(key, source, signal);
      const text = file.text !== undefined;
      const content = file.text ?? file.data;
      const base = { kind: file.kind, revision: file.revision, total: content.length, offset };
      if (cached && cached === file.revision) {
        entries.delete(key);
        return { ...base, encoding: text ? "utf8" : "base64", chunk: "", unchanged: true };
      }
      if (offset > content.length)
        throw new RpcError(RpcErrorCodes.invalidParams, "remote_preview_offset");
      let end = Math.min(content.length, offset + (text ? PREVIEW_TEXT_CHUNK : PREVIEW_DATA_CHUNK));
      // Never split a surrogate pair; the phone appends slices as UTF-8.
      const last = content.charCodeAt(end - 1);
      if (text && end < content.length && last >= 0xd800 && last <= 0xdbff) end--;
      if (end >= content.length) entries.delete(key);
      return {
        ...base,
        encoding: text ? "utf8" : "base64",
        chunk: content.slice(offset, end),
        unchanged: false,
      };
    },
    clear() {
      entries.clear();
    },
  };
}
