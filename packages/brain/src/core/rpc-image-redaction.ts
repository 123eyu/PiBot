import { ImageContentSchema, KernelMethods } from "@pibot/protocol-base";
import type { Redactor } from "@pibot/secrets";
import { redactValue } from "./privacy.ts";

/** Only validated image bytes bypass text redaction; envelope and other fields still pass it. */
export function redactRpcImage(message: unknown, redactor: Redactor): unknown {
  if (!message || typeof message !== "object" || !("result" in message))
    return redactValue(message, redactor);
  const direct = ImageContentSchema.safeParse(message.result);
  const external = KernelMethods["chat.loadExternalImage"].result.safeParse(message.result);
  const image = direct.success
    ? direct.data
    : external.success && external.data.status === "loaded"
      ? external.data.image
      : undefined;
  if (!image) return redactValue(message, redactor);
  const safe = redactValue(
    {
      ...message,
      result: direct.success
        ? { ...image, data: undefined }
        : { status: "loaded", image: { ...image, data: undefined } },
    },
    redactor,
  ) as { result: Record<string, unknown> };
  if (direct.success) safe.result.data = image.data;
  else (safe.result.image as Record<string, unknown>).data = image.data;
  return safe;
}
