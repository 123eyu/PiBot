import type { MethodResults } from "@pibot/protocol";

// The only sender is our renderer, after the existing RPC result schema validation.
const worker = self as unknown as {
  onmessage(event: MessageEvent<MethodResults["chat.attachment"]>): Promise<void>;
  postMessage(result: { blob: Blob } | { error: true }): void;
};
worker.onmessage = async ({ data }) => {
  try {
    const bytes = Uint8Array.from(atob(data.data), (value) => value.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: data.mimeType }));
    let blob: Blob;
    try {
      const scale = Math.min(1, 320 / Math.max(image.width, image.height));
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(image.width * scale)),
        Math.max(1, Math.round(image.height * scale)),
      );
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Preview unavailable");
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
      if (blob.size > 96 * 1024) throw new Error("Preview budget exceeded");
    } finally {
      image.close();
    }
    worker.postMessage({ blob });
  } catch {
    worker.postMessage({ error: true });
  }
};
