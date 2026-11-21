import { z } from "zod";
import { ComputerError } from "../core/errors.ts";
import type { WindowCapture } from "../core/types.ts";
import type { CuaClient } from "../cua/client.ts";

const dimensions = z.object({
  display: z.literal("primary"),
  screenshot_width: z.number().int().positive().max(32768),
  screenshot_height: z.number().int().positive().max(32768),
  screen_width: z.number().positive().max(32768),
  screen_height: z.number().positive().max(32768),
});

/** Native capture is consumed only through the service's existing authorized-window masking. */
export async function capturePrimaryDisplay(
  client: CuaClient,
  index: number,
  signal?: AbortSignal,
): Promise<WindowCapture> {
  if (index !== 0) throw new ComputerError("unsupported", "non_primary_display_unsupported");
  const result = await client.tool("get_desktop_state", {}, signal);
  if (!result.structuredJson || result.structuredJson.length > 16384)
    throw new ComputerError("driver_error", "display_metadata_invalid");
  let parsed: z.infer<typeof dimensions>;
  try {
    parsed = dimensions.parse(JSON.parse(result.structuredJson));
  } catch {
    throw new ComputerError("driver_error", "display_metadata_invalid");
  }
  const image = result.images[0];
  if (
    result.images.length !== 1 ||
    !image ||
    !["image/png", "image/jpeg"].includes(image.mimeType) ||
    image.dataBase64.length > 45_000_000 ||
    parsed.screenshot_width * parsed.screenshot_height > 32_000_000
  )
    throw new ComputerError("driver_error", "display_image_invalid");
  const bytes = Buffer.from(image.dataBase64, "base64");
  if (bytes.toString("base64") !== image.dataBase64)
    throw new ComputerError("driver_error", "display_image_invalid");
  return {
    bytes,
    mimeType: image.mimeType,
    pixels: { width: parsed.screenshot_width, height: parsed.screenshot_height },
    bounds: { x: 0, y: 0, width: parsed.screen_width, height: parsed.screen_height },
  };
}
