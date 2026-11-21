import { AvatarImageSchema } from "@pibot/protocol";

/** Browser decoding and a fresh PNG canvas strip paths, metadata and animation. */
export async function normalizeAvatar(file: File, parent: AbortSignal): Promise<string> {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size > 8 * 1024 * 1024 ||
    file.size === 0
  )
    throw new Error("avatar_image_invalid");
  const signal = AbortSignal.any([parent, AbortSignal.timeout(20_000)]);
  signal.throwIfAborted();
  const bitmap = await new Promise<ImageBitmap>((resolve, reject) => {
    const cancelled = () => reject(signal.reason);
    signal.addEventListener("abort", cancelled, { once: true });
    void createImageBitmap(file).then(
      (image) => {
        signal.removeEventListener("abort", cancelled);
        if (signal.aborted) {
          image.close();
          reject(signal.reason);
        } else resolve(image);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", cancelled);
        reject(error);
      },
    );
  });
  try {
    signal.throwIfAborted();
    if (bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > 16_777_216)
      throw new Error("avatar_image_dimensions");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 192;
    try {
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("avatar_canvas_unavailable");
      const side = Math.min(bitmap.width, bitmap.height);
      ctx.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        192,
        192,
      );
      signal.throwIfAborted();
      return AvatarImageSchema.parse(canvas.toDataURL("image/png"));
    } finally {
      canvas.width = canvas.height = 0;
    }
  } finally {
    bitmap.close();
  }
}
