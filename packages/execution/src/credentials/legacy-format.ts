/** Preserve just-secrets 0.0.2's persisted names and byte representation. */
export function legacyEncoded(value: string) {
  return `secrets:v1:${Buffer.from(value, "utf8").toString("base64")}`;
}

export function legacyDecoded(value: string) {
  if (!value.startsWith("secrets:v1:")) throw new Error("credential_encoding");
  const encoded = value.slice(11);
  const bytes = Buffer.from(encoded, "base64");
  const text = bytes.toString("utf8");
  if (
    bytes.length > 2560 ||
    bytes.toString("base64") !== encoded ||
    !Buffer.from(text).equals(bytes)
  )
    throw new Error("credential_encoding");
  return text;
}

export function legacyWindowsTarget(service: string, name: string) {
  const a = Buffer.from(service),
    b = Buffer.from(name);
  const framed = Buffer.alloc(4 + a.length + b.length);
  framed.writeUInt16BE(a.length, 0);
  framed.writeUInt16BE(b.length, 2);
  a.copy(framed, 4);
  b.copy(framed, 4 + a.length);
  return `secrets:${framed.toString("hex")}`;
}
