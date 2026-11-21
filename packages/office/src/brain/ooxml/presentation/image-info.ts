export function presentationImageInfo(data: Uint8Array | undefined) {
  if (!data || data.length < 24 || data.length > 5 * 1024 * 1024) throw new Error("office_invalid");
  const bytes = Buffer.from(data);
  const checked = (width: number, height: number, extension: "png" | "jpeg") => {
    if (!width || !height || width * height > 16_000_000) throw new Error("office_invalid");
    return { width, height, extension, contentType: `image/${extension}` };
  };
  if (
    bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" &&
    bytes.subarray(12, 16).toString("ascii") === "IHDR"
  )
    return checked(bytes.readUInt32BE(16), bytes.readUInt32BE(20), "png");
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let cursor = 2;
    while (cursor < Math.min(bytes.length, 1024 * 1024)) {
      if (bytes[cursor++] !== 0xff) break;
      while (bytes[cursor] === 0xff) cursor++;
      const marker = bytes[cursor++];
      if (marker === undefined || marker === 0xda || marker === 0xd9 || cursor + 2 > bytes.length)
        break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const size = bytes.readUInt16BE(cursor);
      if (size < 2 || cursor + size > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8)
        return checked(bytes.readUInt16BE(cursor + 5), bytes.readUInt16BE(cursor + 3), "jpeg");
      cursor += size;
    }
  }
  throw new Error("office_unsupported");
}
