/**
 * Drops every application (APP1–APP15) and comment segment of a JPEG before the image reaches a
 * model: EXIF and XMP carry GPS coordinates, device serials and capture details (coordinates
 * never reach a model). The phone already re-encodes the image; this is the desktop's own guarantee and
 * does not trust that. Returns undefined for anything that is not a well-formed baseline header.
 */
export function stripJpegMetadata(input: Buffer): Buffer | undefined {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return undefined;
  const kept: Buffer[] = [input.subarray(0, 2)];
  let at = 2;
  while (at + 4 <= input.length) {
    if (input[at] !== 0xff) return undefined;
    const marker = input[at + 1] as number;
    // Fill bytes before a marker are allowed by the format.
    if (marker === 0xff) {
      at++;
      continue;
    }
    // Start of scan: the entropy-coded image follows to the end; no metadata segments after it
    // matter to a decoder, and the phone's encoder writes none.
    if (marker === 0xda) {
      kept.push(input.subarray(at));
      return Buffer.concat(kept);
    }
    const length = input.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > input.length) return undefined;
    const application = marker >= 0xe1 && marker <= 0xef;
    if (!application && marker !== 0xfe) kept.push(input.subarray(at, at + 2 + length));
    at += 2 + length;
  }
  return undefined;
}
