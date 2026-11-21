import type { Rect, Size } from "../core/types.ts";

/** Uncompressed 32-bit image, 4 bytes per pixel in the codec's native order (BGRA for Electron). */
export interface RawImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Image port: the host injects Electron nativeImage (decode / resize / encode); this package
 * stays free of Electron and native image libraries. Decoding to a bitmap and re-encoding also
 * drops every metadata chunk of the source image.
 */
export interface ImageCodec {
  decode(bytes: Uint8Array): RawImage;
  resize(image: RawImage, size: Size): RawImage;
  encodeJpeg(image: RawImage, quality: number): Uint8Array;
}

export interface EncodedShot {
  bytes: Uint8Array;
  mimeType: "image/jpeg";
  width: number;
  height: number;
}

export function clampRect(rect: Rect, size: Size): Rect {
  const x = Math.max(0, Math.min(size.width, Math.floor(rect.x)));
  const y = Math.max(0, Math.min(size.height, Math.floor(rect.y)));
  const right = Math.max(x, Math.min(size.width, Math.ceil(rect.x + rect.width)));
  const bottom = Math.max(y, Math.min(size.height, Math.ceil(rect.y + rect.height)));
  return { x, y, width: right - x, height: bottom - y };
}

export function crop(image: RawImage, rect: Rect): RawImage {
  const r = clampRect(rect, image);
  const out = new Uint8Array(r.width * r.height * 4);
  for (let row = 0; row < r.height; row++) {
    const from = ((r.y + row) * image.width + r.x) * 4;
    out.set(image.data.subarray(from, from + r.width * 4), row * r.width * 4);
  }
  return { width: r.width, height: r.height, data: out };
}

/**
 * Paints every pixel whose `keep` flag is 0 opaque mid-grey (same bytes in BGRA and RGBA): one
 * flat colour, so nothing of the covered content survives resizing or JPEG.
 */
export function cover(image: RawImage, keep: Uint8Array): void {
  const grey = new Uint8Array(image.width * 4);
  for (let i = 0; i < grey.length; i += 4) grey.set([128, 128, 128, 255], i);
  for (let row = 0; row < image.height; row++) {
    const line = keep.subarray(row * image.width, (row + 1) * image.width);
    for (let x = line.indexOf(0); x !== -1; ) {
      const end = line.indexOf(1, x);
      const stop = end === -1 ? image.width : end;
      image.data.set(grey.subarray(0, (stop - x) * 4), (row * image.width + x) * 4);
      x = end === -1 ? -1 : line.indexOf(0, end);
    }
  }
}

export function fitWithin(size: Size, maxEdge: number): Size {
  const scale = Math.min(1, maxEdge / Math.max(size.width, size.height));
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

const QUALITIES = [80, 65, 50, 40];
const MIN_EDGE = 320;

/**
 * Shrinks to `maxEdge`, then trades JPEG quality and finally size for the byte budget.
 * Screenshots are text-heavy, so quality drops first; each size step is 0.75×, so the loop
 * is bounded (≤ ~6 sizes × 4 qualities) even for a 6K display.
 */
export function compressToBudget(
  codec: ImageCodec,
  image: RawImage,
  maxEdge: number,
  maxBytes: number,
): EncodedShot {
  let size = fitWithin(image, maxEdge);
  for (;;) {
    const scaled =
      size.width === image.width && size.height === image.height
        ? image
        : codec.resize(image, size);
    let last: Uint8Array | undefined;
    for (const quality of QUALITIES) {
      last = codec.encodeJpeg(scaled, quality);
      if (last.byteLength <= maxBytes) return { bytes: last, mimeType: "image/jpeg", ...size };
    }
    const next = fitWithin(size, Math.floor(Math.max(size.width, size.height) * 0.75));
    if (Math.max(next.width, next.height) < MIN_EDGE || !last)
      return { bytes: last ?? codec.encodeJpeg(scaled, 40), mimeType: "image/jpeg", ...size };
    size = next;
  }
}
