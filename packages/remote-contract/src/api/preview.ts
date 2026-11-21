import { PreviewKindSchema, previewSourceParams } from "@pibot/protocol-base";
import { z } from "zod";

// preview.read answers with the whole file (up to ~28 MB of base64), but a phone frame carries
// at most 1 MiB and the gateway caps a response at 900 kB. The phone reads the same result in
// slices; both sizes keep one slice plus its JSON envelope under that cap.
/** Base64 characters per slice: a multiple of 4, so each slice decodes on its own. */
export const PREVIEW_DATA_CHUNK = 786_432;
/** UTF-16 units per text slice: even fully \u-escaped (6 bytes each) it stays under 900 kB. */
export const PREVIEW_TEXT_CHUNK = 131_072;
const MAX_CONTENT = 27_962_028;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const offset = z.number().int().nonnegative().max(MAX_CONTENT);

export const RemotePreviewReadSchema = previewSourceParams({
  /** The revision being continued; every slice after the first names it. */
  revision: revision.optional(),
  /** The revision already cached on the phone; an unchanged file answers without content. */
  cached: revision.optional(),
  offset,
}).refine((input) => input.offset === 0 || !!input.revision, "Later slices need a revision");
export const RemotePreviewChunkSchema = z.strictObject({
  kind: PreviewKindSchema,
  revision,
  /** utf8 = the redacted text of a text format; base64 = the original bytes of a visual one. */
  encoding: z.enum(["utf8", "base64"]),
  total: offset,
  offset,
  chunk: z.string().max(PREVIEW_DATA_CHUNK),
  unchanged: z.boolean(),
});
export type RemotePreviewRead = z.infer<typeof RemotePreviewReadSchema>;
export type RemotePreviewChunk = z.infer<typeof RemotePreviewChunkSchema>;
