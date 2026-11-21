export function imageDimensions(
  data: Buffer,
  mime: string,
): { width: number; height: number } | undefined {
  if (mime === "image/png" && data.length >= 24)
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (mime === "image/gif" && data.length >= 10)
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (mime === "image/jpeg") {
    let offset = 2;
    const frames = new Set([
      0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
    ]);
    while (offset + 4 < data.length) {
      if (data[offset++] !== 0xff) return undefined;
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9 || offset + 2 > data.length)
        return undefined;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) return undefined;
      if (frames.has(marker) && length >= 7)
        return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
      offset += length;
    }
  }
  if (mime === "image/webp") {
    let offset = 12;
    while (offset + 8 <= data.length) {
      const kind = data.subarray(offset, offset + 4).toString("ascii");
      const length = data.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (start + length > data.length) return undefined;
      if (kind === "VP8X" && length >= 10)
        return {
          width: data.readUIntLE(start + 4, 3) + 1,
          height: data.readUIntLE(start + 7, 3) + 1,
        };
      if (kind === "VP8 " && length >= 10)
        return {
          width: data.readUInt16LE(start + 6) & 0x3fff,
          height: data.readUInt16LE(start + 8) & 0x3fff,
        };
      if (kind === "VP8L" && length >= 5 && data[start] === 0x2f) {
        const bits = data.readUInt32LE(start + 1);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      offset = start + length + (length % 2);
    }
  }
  return undefined;
}
