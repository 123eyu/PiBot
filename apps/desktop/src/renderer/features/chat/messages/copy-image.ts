import type { Attachment, Message } from "@pibot/protocol";
import type { useRpc } from "@pibot/renderer-kit";
import { imagePreviewCache } from "./image-preview-cache.ts";

type Peer = NonNullable<ReturnType<typeof useRpc>["peer"]>;

/** The right-clicked image, or the message's only image when the click was on its text. */
export function copyableImage(message: Message, attachmentId?: string): Attachment | undefined {
  const images = message.attachments?.filter((a) => a.kind === "image") ?? [];
  return attachmentId
    ? images.find((a) => a.id === attachmentId)
    : images.length === 1
      ? images[0]
      : undefined;
}

/**
 * Copies the original image, not the thumbnail. The clipboard write starts inside the click and
 * receives the PNG as a promise, so the user gesture still counts after the slow read. Chromium's
 * async clipboard only accepts image/png, so JPEG and WebP results are re-encoded first.
 */
export function copyImage(peer: Peer, message: Message, image: Attachment, signal: AbortSignal) {
  return navigator.clipboard.write([
    new ClipboardItem({ "image/png": png(peer, message, image, signal) }),
  ]);
}

async function png(peer: Peer, message: Message, image: Attachment, signal: AbortSignal) {
  const original = await imagePreviewCache(peer).original(image, signal, message.id);
  const bytes = Uint8Array.from(atob(original.data), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: original.mimeType });
  if (original.mimeType === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    bitmap.close();
  }
}
