import { type ImageContent, ImageContentSchema, MAX_ATTACHMENTS } from "@pibot/protocol-base";
import { z } from "zod";
import { AgentError } from "../core/errors.ts";

// The envelope is bounded before JSON decoding, including unknown supplier fields.
const BODY_LIMIT = 72 * 1024 * 1024;
export async function imageJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new AgentError(
      response.status === 401 || response.status === 403
        ? "auth_failed"
        : response.status === 402
          ? "billing"
          : response.status === 429
            ? "rate_limited"
            : "provider_error",
      response.status,
    );
  }
  const length = Number(response.headers.get("content-length"));
  if (length > BODY_LIMIT) {
    await response.body?.cancel();
    throw new AgentError("provider_error");
  }
  if (!response.body) throw new AgentError("provider_error");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let cancelling: Promise<void> | undefined;
  const stop = () => {
    cancelling ??= reader.cancel().catch(() => {
      // An aborted stream may already reject cancellation; await its teardown before release.
    });
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > BODY_LIMIT) {
        await reader.cancel();
        throw new AgentError("provider_error");
      }
      chunks.push(part.value);
    }
    // Once EOF arrived, validation may preserve a complete paid output for managed retention.
    // Partial/cancelled bodies still fail JSON/image validation; reads above remain abortable.
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new AgentError("provider_error");
    }
  } finally {
    signal.removeEventListener("abort", stop);
    await cancelling;
    reader.releaseLock();
  }
}

const numeric = z.number().finite().nonnegative();
const usageSchema = z.object({
  input_tokens: numeric.optional(),
  output_tokens: numeric.optional(),
  prompt_tokens: numeric.optional(),
  completion_tokens: numeric.optional(),
  total_tokens: numeric.optional(),
  cost: numeric.optional(),
});
export function imageUsage(value: unknown) {
  const parsed = usageSchema.safeParse(value);
  if (!parsed.success) return undefined;
  // pi requires numeric fields; -1 preserves unknown values until brain sanitizes the DTO.
  const input = parsed.data.input_tokens ?? parsed.data.prompt_tokens ?? -1;
  const output = parsed.data.output_tokens ?? parsed.data.completion_tokens ?? -1;
  return {
    input,
    output,
    cacheRead: -1,
    cacheWrite: -1,
    totalTokens: parsed.data.total_tokens ?? (input >= 0 && output >= 0 ? input + output : -1),
    cost: { input: -1, output: -1, cacheRead: -1, cacheWrite: -1, total: parsed.data.cost ?? -1 },
  };
}
export function checkedImage(data: string, mimeType?: string): ImageContent {
  // Never treat a supplier URL as bytes, nor trust a vector's unrendered active content.
  const bytes = Buffer.from(data.slice(0, 32), "base64");
  const detected = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? "image/jpeg"
      : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP"
        ? "image/webp"
        : /^GIF8[79]a/.test(bytes.toString())
          ? "image/gif"
          : undefined;
  if (!detected || (mimeType && detected !== mimeType)) throw new AgentError("provider_error");
  const parsed = ImageContentSchema.safeParse({ type: "image", data, mimeType: detected });
  if (!parsed.success) throw new AgentError("provider_error");
  return parsed.data;
}
const item = z.object({ b64_json: z.string(), media_type: z.string().optional() });
const envelope = z.object({
  data: z.array(item).min(1).max(MAX_ATTACHMENTS),
  usage: z.unknown().optional(),
});
export function standardImages(value: unknown) {
  const parsed = envelope.safeParse(value);
  if (!parsed.success) throw new AgentError("provider_error");
  return {
    images: parsed.data.data.map((entry) => checkedImage(entry.b64_json, entry.media_type)),
    text: "",
    usage: imageUsage(parsed.data.usage),
  };
}
