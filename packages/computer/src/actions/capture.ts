import type { HostComputerParams, HostComputerResults } from "@pibot/protocol-base";
import { type Call, resolveApp, resolveWindow, type ServiceContext } from "../core/context.ts";
import { ComputerError } from "../core/errors.ts";
import type { Rect, WindowInfo } from "../core/types.ts";
import { captureDisplay, intersect, regionPixels } from "./capture-mask.ts";
import { clampRect, compressToBudget, crop, type RawImage } from "./image.ts";

type Params = HostComputerParams["host.computer.screenshot"];
type Result = HostComputerResults["host.computer.screenshot"];

const DEFAULT_MAX_BYTES = 800 * 1024;

// A failed capture of a visible window is retried once after this pause before falling back.
const RETRY_MS = 300;
// Below this share of the window's pixels left visible, the display fallback shows nothing useful.
const MIN_VISIBLE_SHARE = 0.05;

interface Shot {
  image: RawImage;
  bounds: Rect;
  masked: number;
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(new ComputerError("cancelled", "screenshot_retry"));
    };
    signal.addEventListener("abort", stop, { once: true });
  });

/** The driver's capture of a window that is on screen, on this Space and not minimised. */
const unexplained = (error: unknown): error is ComputerError =>
  error instanceof ComputerError && error.detail === "window_not_capturable";

/**
 * A window capture. The owner's Notes / WeChat windows failed most of the time (Cua: "No content
 * produced") while visible, on this Space and not minimised, with tree reads of the same window
 * working; Pi Bot's probes could not reproduce it. So: a TCC preflight that says
 * no is reported as such, one retry covers a transient failure, then the window's area of the
 * display is captured and masked exactly like a display screenshot, which shows no
 * more than a window capture would.
 */
async function windowShot(ctx: ServiceContext, call: Call, window: WindowInfo): Promise<Shot> {
  const fromDriver = async () => {
    const shot = await ctx.driver.captureWindow(window, call.signal);
    return { image: ctx.codec.decode(shot.bytes), bounds: shot.bounds, masked: 0 };
  };
  let first: ComputerError;
  try {
    return await fromDriver();
  } catch (error) {
    if (!unexplained(error)) throw error;
    first = error;
  }
  if (ctx.screenAccess?.() === "denied")
    throw new ComputerError("permission_missing", "screen_recording", first.diagnostic);
  await pause(RETRY_MS, call.signal);
  try {
    return await fromDriver();
  } catch (error) {
    if (!unexplained(error)) throw error;
  }
  return displayRegion(ctx, call, window, first);
}

async function displayRegion(
  ctx: ServiceContext,
  call: Call,
  window: WindowInfo,
  failed: ComputerError,
): Promise<Shot> {
  // macOS only: the failure was seen there, and on Linux / Wayland a display capture can raise
  // the desktop portal's picker dialog, which must not appear behind a window screenshot.
  const index =
    ctx.driver.platform === "darwin" ? ctx.displays?.displayFor?.(window.bounds) : undefined;
  if (!ctx.displays || index === undefined)
    throw new ComputerError("window_not_found", "window_not_capturable", failed.diagnostic);
  let shot: Awaited<ReturnType<typeof captureDisplay>>;
  try {
    shot = await captureDisplay(ctx, call, index);
  } catch (error) {
    // The OS says Screen Recording is on, yet neither capture path got a picture: typically a
    // grant left over from an earlier install that no longer matches this app's signature.
    if (error instanceof ComputerError && error.code === "permission_missing")
      throw new ComputerError(
        "permission_missing",
        "screen_recording_not_effective",
        [failed.diagnostic, "display capture empty"].filter(Boolean).join("; "),
      );
    throw error;
  }
  const hit = intersect(window.bounds, shot.bounds);
  if (!hit) throw new ComputerError("window_not_found", "window_not_capturable", failed.diagnostic);
  const { masked, keep } = shot;
  const pixels = clampRect(
    regionPixels(
      { ...hit, x: hit.x - shot.bounds.x, y: hit.y - shot.bounds.y },
      shot.bounds,
      shot.image,
    ),
    shot.image,
  );
  let shown = 0;
  for (let row = pixels.y; row < pixels.y + pixels.height; row++)
    for (let at = row * shot.image.width + pixels.x, end = at + pixels.width; at < end; at++)
      shown += keep[at] ?? 0;
  if (shown < pixels.width * pixels.height * MIN_VISIBLE_SHARE)
    throw new ComputerError(
      "window_not_found",
      "window_covered_by_other_windows",
      failed.diagnostic,
    );
  return { image: crop(shot.image, pixels), bounds: hit, masked };
}

/**
 * Screenshots: a granted app's window only (Cua captures the window itself, so
 * other apps' windows never appear), or — only with "allow screenshot clicks" — a whole
 * display with everything outside the granted apps' windows painted over. Always
 * re-encoded (drops metadata) and fitted into maxEdge and the byte budget; the frame is
 * remembered for pointer calls.
 */
export async function screenshot(ctx: ServiceContext, call: Call, params: Params): Promise<Result> {
  let image: RawImage;
  let logical: Rect;
  let kind: "window" | "display";
  let pid: number | undefined;
  let windowId: string | undefined;
  let masked = 0;
  if (params.app !== undefined) {
    const app = await resolveApp(ctx, call, params.app);
    const window = await resolveWindow(ctx, call, app, params.window);
    const shot = await windowShot(ctx, call, window);
    image = shot.image;
    logical = shot.bounds;
    masked = shot.masked;
    kind = "window";
    pid = app.pid;
    windowId = window.id;
  } else {
    if (!call.scope.allowCoordinates)
      throw new ComputerError("coordinates_not_allowed", "display_screenshot");
    if (!ctx.displays) throw new ComputerError("unsupported", "display_capture_unavailable");
    const shot = await captureDisplay(ctx, call, params.display ?? 0);
    image = shot.image;
    logical = shot.bounds;
    kind = "display";
    masked = shot.masked;
  }
  let origin = { x: logical.x, y: logical.y };
  let size = { width: logical.width, height: logical.height };
  if (params.region) {
    const local = intersect(params.region, {
      x: 0,
      y: 0,
      width: logical.width,
      height: logical.height,
    });
    if (!local) throw new ComputerError("driver_error", "region_outside_capture");
    image = crop(image, regionPixels(local, logical, image));
    origin = { x: logical.x + local.x, y: logical.y + local.y };
    size = { width: local.width, height: local.height };
  }
  const encoded = compressToBudget(
    ctx.codec,
    image,
    params.maxEdge,
    params.maxBytes ?? DEFAULT_MAX_BYTES,
  );
  const screenshotId = ctx.frames.add({
    kind,
    grantKey: call.grantKey,
    pid,
    windowId,
    origin,
    size,
    pixels: { width: encoded.width, height: encoded.height },
  });
  return {
    ok: true,
    screenshotId,
    image: {
      type: "image",
      data: Buffer.from(encoded.bytes).toString("base64"),
      mimeType: encoded.mimeType,
    },
    width: encoded.width,
    height: encoded.height,
    scope: kind,
    masked,
  };
}
