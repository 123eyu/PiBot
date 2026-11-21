const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const at = (n: number) => ALPHABET.charAt(n & 63);

/** Standard base64 with padding (the link's own helper is base64url); joins parts, no O(n²). */
export function toBase64(bytes: Uint8Array) {
  const parts: string[] = [];
  let line = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n =
      ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    line += at(n >> 18) + at(n >> 12) + at(n >> 6) + at(n);
    if (line.length >= 8192) {
      parts.push(line);
      line = "";
    }
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] as number) << 16;
    line += `${at(n >> 18)}${at(n >> 12)}==`;
  } else if (rest === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    line += `${at(n >> 18)}${at(n >> 12)}${at(n >> 6)}=`;
  }
  parts.push(line);
  return parts.join("");
}
