import { IMAGE_LIMIT, RpcError, RpcErrorCodes } from "@pibot/browser-contract/full";
import type { Cdp } from "../cdp.ts";

// Bound decoded work as well as transport bytes, including high-DPI responsive captures.
const PIXELS = 16_000_000;
const EDGE = 12_000;
interface Viewport {
  clientWidth: number;
  clientHeight: number;
  pageX?: number;
  pageY?: number;
}
const unavailable = () => new RpcError(RpcErrorCodes.unsupported, "browser_screenshot_unavailable");

export async function screenshotPage(
  cdp: Cdp,
  fullPage: boolean,
  surfaceClip = fullPage,
  signal?: AbortSignal,
) {
  // Layout and size reductions share one budget; an unresponsive page must not multiply waits.
  const deadline = performance.now() + 3000;
  const remaining = () => {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0) throw new RpcError(RpcErrorCodes.timeout, "browser_screenshot_unavailable");
    return ms;
  };
  const metrics = await cdp.send<{
    cssContentSize: { width: number; height: number };
    cssLayoutViewport: Viewport;
    cssVisualViewport?: Viewport;
  }>("Page.getLayoutMetrics", {}, remaining(), signal);
  const view = fullPage
    ? metrics.cssLayoutViewport
    : (metrics.cssVisualViewport ?? metrics.cssLayoutViewport);
  const width = Math.max(1, Math.round(view.clientWidth));
  const height = Math.max(
    1,
    Math.round(fullPage ? Math.min(metrics.cssContentSize.height, EDGE) : view.clientHeight),
  );
  const x = fullPage ? 0 : (view.pageX ?? 0);
  const y = fullPage ? 0 : (view.pageY ?? 0);
  if (![width, height, x, y].every(Number.isFinite) || x < 0 || y < 0) throw unavailable();
  let scale = Math.min(1, EDGE / Math.max(width, height), Math.sqrt(PIXELS / (width * height)));
  // Both viewport and full-page captures need an actual scaled clip. Guessing dimensions from
  // CSS size misses deviceScaleFactor, while shrinking only metadata does not shrink pixels.
  for (let attempt = 0; attempt < 3; attempt++, scale /= 2) {
    const { data } = await cdp.send<{ data: string }>(
      "Page.captureScreenshot",
      {
        format: "jpeg",
        quality: 70,
        fromSurface: true,
        captureBeyondViewport: surfaceClip,
        clip: { x, y, width, height, scale },
      },
      remaining(),
      signal,
    );
    if (Buffer.byteLength(data, "base64") > IMAGE_LIMIT) continue;
    // The real pixel size (CSS size × scale × device pixel ratio) comes from the JPEG header:
    // decoding it with nativeImage blocked the desktop main loop for seconds on large pages.
    const size = jpegSize(Buffer.from(data, "base64"));
    if (!size || size.width < 1 || size.height < 1) throw unavailable();
    if (size.width * size.height > PIXELS || Math.max(size.width, size.height) > EDGE) continue;
    return {
      image: { type: "image" as const, data, mimeType: "image/jpeg" as const },
      ...size,
    };
  }
  throw new RpcError(RpcErrorCodes.unsupported, "browser_screenshot_too_large");
}

/** Width and height from a JPEG's start-of-frame marker, without decoding the image. */
export function jpegSize(data: Buffer): { width: number; height: number } | undefined {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined;
  let at = 2;
  while (at + 9 < data.length) {
    if (data[at] !== 0xff) return undefined;
    const marker = data[at + 1] ?? 0;
    // Fill bytes and standalone markers carry no length.
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = data.readUInt16BE(at + 2);
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) hold the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
    if (marker === 0xda || length < 2) return undefined;
    at += 2 + length;
  }
  return undefined;
}
