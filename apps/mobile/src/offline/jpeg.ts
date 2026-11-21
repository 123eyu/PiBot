import { toBase64 } from "../storage/base64.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VALUES = new Map([...ALPHABET].map((c, i) => [c, i]));

export function fromBase64(text: string): Uint8Array | undefined {
  const clean = text.replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of clean) {
    value = (value << 6) | (VALUES.get(char) as number);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 255;
    }
  }
  return out;
}
/**
 * Drops every application (APP1–APP15) and comment segment before a photo goes to a model vendor:
 * EXIF/XMP carry GPS coordinates and device details. Offline there is no computer to
 * do this, so the phone does what `remote/brain/phone-data/jpeg.ts` does on the desktop.
 */
export function stripJpegMetadata(input: Uint8Array): Uint8Array | undefined {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return undefined;
  const kept: Uint8Array[] = [input.subarray(0, 2)];
  let at = 2;
  while (at + 4 <= input.length) {
    if (input[at] !== 0xff) return undefined;
    const marker = input[at + 1] as number;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xda) {
      kept.push(input.subarray(at));
      const total = kept.reduce((sum, part) => sum + part.length, 0);
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const part of kept) {
        joined.set(part, offset);
        offset += part.length;
      }
      return joined;
    }
    const length = ((input[at + 2] as number) << 8) | (input[at + 3] as number);
    if (length < 2 || at + 2 + length > input.length) return undefined;
    const application = marker >= 0xe1 && marker <= 0xef;
    if (!application && marker !== 0xfe) kept.push(input.subarray(at, at + 2 + length));
    at += 2 + length;
  }
  return undefined;
}
/** Base64 JPEG in, base64 JPEG without metadata out; undefined when it is not a usable JPEG. */
export function cleanJpegBase64(base64: string) {
  const bytes = fromBase64(base64);
  const stripped = bytes && stripJpegMetadata(bytes);
  return stripped ? toBase64(stripped) : undefined;
}
