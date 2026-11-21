import { type BrowserFrameMessage, BrowserFrameMessageSchema } from "@pibot/protocol";

/** macOS relay: the owner's frames arrive as JSON over the socket with base64 image bytes. */
export function encodeFrameWire(message: BrowserFrameMessage): unknown {
  return message.type === "frame"
    ? { ...message, data: Buffer.from(message.data).toString("base64") }
    : message;
}

export function decodeFrameWire(value: unknown): BrowserFrameMessage | undefined {
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "frame" &&
    "data" in value &&
    typeof value.data === "string"
  ) {
    const bytes = Buffer.from(value.data, "base64");
    const parsed = BrowserFrameMessageSchema.safeParse({
      ...value,
      data: new Uint8Array(bytes),
    });
    return parsed.success ? parsed.data : undefined;
  }
  const parsed = BrowserFrameMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
