import type { ImageCodec, RawImage } from "@pibot/computer";
import { ComputerError } from "@pibot/computer";

const MAX_PIXELS = 32_000_000;
function size(width: number, height: number) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > MAX_PIXELS
  )
    throw new ComputerError("driver_error", "image_dimensions_invalid");
}
export function createRunnerImageCodec(native: typeof import("@napi-rs/image")): ImageCodec {
  const { Transformer, JsColorType, ResizeFilterType, ResizeFit } = native;
  function raw(image: RawImage) {
    size(image.width, image.height);
    if (image.data.byteLength !== image.width * image.height * 4)
      throw new ComputerError("driver_error", "image_pixels_invalid");
    return Transformer.fromRgbaPixels(image.data, image.width, image.height);
  }

  /** RGBA throughout; re-encoding from masked pixels never preserves source image metadata. */
  return {
    decode(bytes) {
      if (bytes.byteLength > 32 * 1024 * 1024)
        throw new ComputerError("driver_error", "image_bytes_limit");
      const image = new Transformer(bytes);
      const metadata = image.metadataSync();
      size(metadata.width, metadata.height);
      const channels =
        metadata.colorType === JsColorType.L8
          ? 1
          : metadata.colorType === JsColorType.La8
            ? 2
            : metadata.colorType === JsColorType.Rgb8
              ? 3
              : metadata.colorType === JsColorType.Rgba8
                ? 4
                : 0;
      if (!channels) throw new ComputerError("driver_error", "image_color_unsupported");
      const input = image.rawPixelsSync();
      if (input.byteLength !== metadata.width * metadata.height * channels)
        throw new ComputerError("driver_error", "image_pixels_invalid");
      const data = new Uint8Array(metadata.width * metadata.height * 4);
      for (let from = 0, to = 0; from < input.length; from += channels, to += 4) {
        data[to] = input[from] ?? 0;
        data[to + 1] = input[from + (channels < 3 ? 0 : 1)] ?? 0;
        data[to + 2] = input[from + (channels < 3 ? 0 : 2)] ?? 0;
        data[to + 3] =
          channels === 2
            ? (input[from + 1] ?? 255)
            : channels === 4
              ? (input[from + 3] ?? 255)
              : 255;
      }
      return { width: metadata.width, height: metadata.height, data };
    },
    resize(image, target) {
      size(target.width, target.height);
      return {
        ...target,
        data: new Uint8Array(
          raw(image)
            .resize(target.width, target.height, ResizeFilterType.Lanczos3, ResizeFit.Fill)
            .rawPixelsSync(),
        ),
      };
    },
    encodeJpeg: (image, quality) => new Uint8Array(raw(image).jpegSync(quality)),
  };
}
