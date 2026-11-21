export type RandomBytes = (length: number) => Uint8Array;
export const EMPTY = new Uint8Array();
export const MAX_FRAME = 1_048_576;
export const MAX_PLAINTEXT = MAX_FRAME - 24;
export class LinkError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "LinkError";
  }
}
export function requireBytes(value: Uint8Array, length: number) {
  if (!(value instanceof Uint8Array) || value.length !== length) throw new LinkError("invalid_key");
  return value;
}
export function concat(...parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
export function equal(a: Uint8Array, b: Uint8Array) {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}
// Hermes need not provide TextEncoder/TextDecoder; the wire always uses strict UTF-8.
export function utf8(value: string) {
  const bytes: number[] = [];
  for (const character of value) {
    let c = character.codePointAt(0) as number;
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 128) bytes.push(c);
    else if (c < 2048) bytes.push(192 | (c >> 6), 128 | (c & 63));
    else if (c < 65536) bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
    else bytes.push(240 | (c >> 18), 128 | ((c >> 12) & 63), 128 | ((c >> 6) & 63), 128 | (c & 63));
  }
  return Uint8Array.from(bytes);
}
export function text(bytes: Uint8Array) {
  const characters: string[] = [];
  for (let i = 0; i < bytes.length; ) {
    const first = bytes[i++] as number;
    const count =
      first < 128
        ? 0
        : first >= 194 && first <= 223
          ? 1
          : first <= 239 && first >= 224
            ? 2
            : first >= 240 && first <= 244
              ? 3
              : -1;
    if (count < 0 || i + count > bytes.length) throw new LinkError("invalid_utf8");
    let code = first & (count === 0 ? 127 : (1 << (6 - count)) - 1);
    for (let j = 0; j < count; j++) {
      const next = bytes[i++] as number;
      if ((next & 192) !== 128) throw new LinkError("invalid_utf8");
      code = (code << 6) | (next & 63);
    }
    if (
      (count > 0 && code < ([0, 128, 2048, 65536][count] as number)) ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      throw new LinkError("invalid_utf8");
    characters.push(String.fromCodePoint(code));
  }
  return characters.join("");
}
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function base64url(bytes: Uint8Array) {
  let result = "",
    bits = 0,
    value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      result += alphabet[(value >>> bits) & 63];
    }
  }
  if (bits) result += alphabet[(value << (6 - bits)) & 63];
  return result;
}
export function unbase64(value: string, max = MAX_FRAME) {
  if (
    !/^[A-Za-z0-9_-]*$/.test(value) ||
    value.length % 4 === 1 ||
    value.length > Math.ceil((max * 4) / 3)
  )
    throw new LinkError("invalid_encoding");
  const result: number[] = [];
  let bits = 0,
    current = 0;
  for (const character of value) {
    current = (current << 6) | alphabet.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      result.push((current >>> bits) & 255);
    }
  }
  const decoded = Uint8Array.from(result);
  if (decoded.length > max || base64url(decoded) !== value) throw new LinkError("invalid_encoding");
  return decoded;
}
export function sequence(n: bigint) {
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) bytes[i] = Number((n >> BigInt(i * 8)) & 255n);
  return bytes;
}
export function readSequence(bytes: Uint8Array) {
  let n = 0n;
  for (let i = 7; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i] as number);
  return n;
}
