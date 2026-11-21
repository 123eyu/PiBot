import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

const QUALITIES = [0.8, 0.65, 0.5, 0.35];

/**
 * Re-encodes an image as JPEG within an edge and byte budget (stepping quality down, then size).
 * Re-encoding also drops the original's metadata (EXIF/GPS); the computer strips again anyway.
 */
export async function encodeJpeg(
  uri: string,
  size: { width: number; height: number },
  limits: { maxEdge: number; maxBytes: number },
  base64: boolean,
) {
  if (!size.width || !size.height) {
    // The share sheet does not always know the size; decode once to learn it.
    const context = ImageManipulator.manipulate(uri);
    const probe = await context.renderAsync();
    size = { width: probe.width, height: probe.height };
    probe.release();
    context.release();
  }
  let edge = Math.min(limits.maxEdge, Math.max(size.width, size.height) || limits.maxEdge);
  for (let round = 0; round < 4; round++) {
    const scale = Math.min(1, edge / Math.max(size.width || edge, size.height || edge));
    const context = ImageManipulator.manipulate(uri);
    if (scale < 1)
      context.resize(
        size.width >= size.height
          ? { width: Math.round(size.width * scale) }
          : { height: Math.round(size.height * scale) },
      );
    const image = await context.renderAsync();
    try {
      for (const compress of QUALITIES) {
        const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress, base64 });
        const bytes = saved.base64
          ? Math.floor((saved.base64.length * 3) / 4)
          : (new File(saved.uri).size ?? Number.POSITIVE_INFINITY);
        if (bytes <= limits.maxBytes) return { ...saved, bytes };
      }
    } finally {
      image.release();
      context.release();
    }
    edge = Math.round(edge * 0.75);
  }
  throw new Error("image_too_large");
}
