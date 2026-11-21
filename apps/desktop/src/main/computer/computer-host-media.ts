import type { DisplayCapture, ImageCodec, RawImage } from "@pibot/computer";
import { ComputerError } from "@pibot/computer";
import { desktopCapturer, nativeImage, screen } from "electron";

/**
 * nativeImage as the computer package's image port. Bitmaps stay in Electron's native byte
 * order end to end (decode → crop/mask in JS → encode), so the order never matters here.
 */
export const nativeImageCodec: ImageCodec = {
  decode(bytes) {
    const image = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (image.isEmpty()) throw new ComputerError("driver_error", "image_decode_failed");
    const { width, height } = image.getSize();
    return { width, height, data: new Uint8Array(image.toBitmap()) };
  },
  resize(image, size) {
    const resized = fromRaw(image).resize({
      width: size.width,
      height: size.height,
      quality: "good",
    });
    const actual = resized.getSize();
    return { width: actual.width, height: actual.height, data: new Uint8Array(resized.toBitmap()) };
  },
  encodeJpeg(image, quality) {
    return new Uint8Array(fromRaw(image).toJPEG(quality));
  },
};

function fromRaw(image: RawImage) {
  return nativeImage.createFromBitmap(
    Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength),
    {
      width: image.width,
      height: image.height,
    },
  );
}

/** Displays in a stable order for the model: main display first, then left to right. */
function orderedDisplays() {
  const primary = screen.getPrimaryDisplay();
  return [
    primary,
    ...screen
      .getAllDisplays()
      .filter((d) => d.id !== primary.id)
      .sort((a, b) => a.bounds.x - b.bounds.x),
  ];
}

/**
 * Whole-display capture through desktopCapturer (works in the windowless background process
 * and while locked); ~0.3–0.8 s per call. Only used for "allow screenshot clicks" grants.
 */
export const electronDisplays: DisplayCapture = {
  displayFor(rect) {
    const match = screen.getDisplayMatching({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    });
    const index = orderedDisplays().findIndex((d) => d.id === match.id);
    return index < 0 ? undefined : index;
  },
  async capture(index, signal) {
    const display = orderedDisplays()[index];
    if (!display) throw new ComputerError("window_not_found", "no_such_display");
    const thumbnailSize = {
      width: Math.round(display.bounds.width * display.scaleFactor),
      height: Math.round(display.bounds.height * display.scaleFactor),
    };
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize });
    if (signal?.aborted) throw new ComputerError("cancelled", "display_capture");
    const source =
      sources.find((s) => s.display_id === String(display.id)) ??
      (sources.length === 1 ? sources[0] : undefined);
    if (!source || source.thumbnail.isEmpty())
      throw new ComputerError("permission_missing", "screen_recording");
    const { width, height } = source.thumbnail.getSize();
    return {
      image: { width, height, data: new Uint8Array(source.thumbnail.toBitmap()) },
      bounds: { ...display.bounds },
    };
  },
};
