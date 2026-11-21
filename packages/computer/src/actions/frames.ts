import { randomBytes } from "node:crypto";
import type { Point, Size } from "../core/types.ts";

/**
 * What a screenshot showed, so a later pointer call can turn the model's pixel coordinates
 * back into global logical points:
 *   point = origin + pixel × logicalSize / pixelSize
 * per window or per display, which is what keeps Retina (2×) and 1× external displays right.
 */
export interface Frame {
  kind: "window" | "display";
  /** Grant the screenshot was taken under; frames are not shared across runs. */
  grantKey: string;
  pid?: number;
  windowId?: string;
  /** Global logical point of the image's top-left pixel. */
  origin: Point;
  /** Logical size the image covers. */
  size: Size;
  /** Pixel size of the image the model received. */
  pixels: Size;
  at: number;
}

export function toGlobal(frame: Frame, pixel: Point): Point {
  return {
    x: frame.origin.x + (pixel.x * frame.size.width) / frame.pixels.width,
    y: frame.origin.y + (pixel.y * frame.size.height) / frame.pixels.height,
  };
}

export function inside(frame: Pick<Frame, "pixels">, pixel: Point): boolean {
  return (
    pixel.x >= 0 && pixel.y >= 0 && pixel.x < frame.pixels.width && pixel.y < frame.pixels.height
  );
}

/** Recent screenshots only: a frame older than `ttlMs` must be re-taken before clicking. */
export function createFrameRegistry(
  options: { max?: number; ttlMs?: number; now?: () => number } = {},
) {
  const max = options.max ?? 32;
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  const frames = new Map<string, Frame>();
  return {
    add(frame: Omit<Frame, "at">): string {
      const id = randomBytes(12).toString("base64url");
      frames.set(id, { ...frame, at: now() });
      while (frames.size > max) frames.delete(frames.keys().next().value as string);
      return id;
    },
    get(id: string, grantKey: string): Frame | undefined {
      const frame = frames.get(id);
      if (!frame || frame.grantKey !== grantKey) return undefined;
      if (now() - frame.at > ttlMs) {
        frames.delete(id);
        return undefined;
      }
      return frame;
    },
    dropGrant(grantKey: string) {
      for (const [id, frame] of [...frames]) if (frame.grantKey === grantKey) frames.delete(id);
    },
    clear: () => frames.clear(),
  };
}
