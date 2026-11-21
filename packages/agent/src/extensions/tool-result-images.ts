import { base64Bytes, type ImageContent, ImageContentSchema } from "@pibot/protocol-base";
import { untilAborted } from "../core/abort.ts";

const UNSUPPORTED = "[image omitted: unsupported format / 已省略图片：格式不支持]";

/**
 * pi's converter takes no AbortSignal, so a timed-out or cancelled conversion keeps running in
 * WASM. Allow only one at a time process-wide: while an abandoned one is still busy, later GIFs
 * get the fixed note instead of piling up CPU and memory.
 */
let converting: Promise<unknown> | undefined;

async function gifToPng(image: ImageContent, signal: AbortSignal, deadline: AbortSignal) {
  signal.throwIfAborted();
  if (converting) return undefined;
  const bounded = AbortSignal.any([signal, deadline]);
  try {
    // The public root exports this existing WASM converter; load the interactive graph only
    // for GIFs, after the session has sanitized the environment, never on the startup path.
    const conversion = (async () => {
      const { convertToPng } = await import("@earendil-works/pi-coding-agent");
      bounded.throwIfAborted();
      return convertToPng(image.data, image.mimeType);
    })();
    const running = conversion.then(
      () => undefined,
      () => undefined,
    );
    converting = running;
    void running.then(() => {
      if (converting === running) converting = undefined;
    });
    const converted = await untilAborted(conversion, bounded);
    signal.throwIfAborted();
    const parsed = ImageContentSchema.safeParse(
      converted ? { ...converted, type: "image" } : undefined,
    );
    return parsed.success && parsed.data.mimeType === "image/png" ? parsed.data : undefined;
  } catch {
    signal.throwIfAborted();
    // Missing backend, decoding failure or the conversion deadline only omits this image.
    return undefined;
  }
}

/** A failed image must not discard the tool's text or its other usable images. */
export async function toolResultImages(
  value: unknown,
  model: { id: string; api: string; input: readonly string[] } | undefined,
  signal: AbortSignal,
): Promise<(ImageContent | { type: "text"; text: string })[]> {
  const content: (ImageContent | { type: "text"; text: string })[] = [];
  let bytes = 0;
  // One budget for the whole result, not 10 s per image (up to five GIFs).
  const deadline = AbortSignal.timeout(10_000);
  const gemini = /gemini/i.test(model?.id ?? "") || model?.api.startsWith("google-");
  for (const valueImage of (Array.isArray(value) ? value : []).slice(0, 5)) {
    signal.throwIfAborted();
    const parsed = ImageContentSchema.safeParse(valueImage);
    if (!parsed.success) {
      content.push({ type: "text", text: UNSUPPORTED });
      continue;
    }
    if (!model?.input.includes("image")) {
      content.push({
        type: "text",
        text: "[image omitted: model does not accept image input / 已省略图片：模型不支持图片输入]",
      });
      continue;
    }
    const image =
      gemini && parsed.data.mimeType === "image/gif"
        ? await gifToPng(parsed.data, signal, deadline)
        : parsed.data;
    if (!image) {
      content.push({ type: "text", text: UNSUPPORTED });
      continue;
    }
    const size = base64Bytes(image.data);
    if (bytes + size > 20 * 1024 * 1024) {
      content.push({
        type: "text",
        text: "[image omitted: image context budget / 已省略图片：超出图片上下文预算]",
      });
      continue;
    }
    content.push(image);
    bytes += size;
  }
  return content;
}
