export function previewBytes(data: string): Uint8Array<ArrayBuffer> {
  const raw = atob(data),
    bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}
