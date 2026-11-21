import { type Call, isBlocked, type ServiceContext } from "../core/context.ts";
import { ComputerError } from "../core/errors.ts";
import type { AppInfo, Rect, WindowInfo } from "../core/types.ts";
import { isBlockedWindow } from "../guard/blocklist.ts";
import { grantCovers } from "../guard/grants.ts";
import { clampRect, cover, type RawImage } from "./image.ts";

export function intersect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}

/** Logical region (relative to the captured area) → pixel rect of `image`. */
export function regionPixels(region: Rect, logical: Rect, image: RawImage): Rect {
  const sx = image.width / logical.width;
  const sy = image.height / logical.height;
  return {
    x: region.x * sx,
    y: region.y * sy,
    width: region.width * sx,
    height: region.height * sy,
  };
}

interface Snapshot {
  apps: AppInfo[];
  windows: WindowInfo[];
  allowed: Set<string>;
  signature: string;
}
async function snapshot(ctx: ServiceContext, call: Call): Promise<Snapshot> {
  const [apps, windows] = await Promise.all([
    ctx.driver.listApps(call.signal),
    ctx.driver.onScreenWindows(call.signal),
  ]);
  const byPid = new Map(apps.map((app) => [app.pid, app]));
  const allowed = new Set<string>();
  for (const window of windows) {
    const app = byPid.get(window.pid);
    if (
      app &&
      grantCovers(call.scope, app) &&
      !isBlocked(ctx, app) &&
      !isBlockedWindow(app, window)
    )
      allowed.add(window.id);
  }
  return {
    apps,
    windows,
    allowed,
    signature: JSON.stringify(
      windows.map((window) => [
        window.id,
        window.pid,
        window.bounds,
        window.z,
        window.layer,
        allowed.has(window.id),
      ]),
    ),
  };
}

/** Both window lists constrain visibility; an unstable frame is erased and never encoded. */
export async function captureDisplay(ctx: ServiceContext, call: Call, index: number) {
  if (!ctx.displays) throw new ComputerError("unsupported", "display_capture_unavailable");
  for (let attempt = 0; attempt < 3; attempt++) {
    call.signal.throwIfAborted();
    const before = await snapshot(ctx, call);
    const shot = await ctx.displays.capture(index, call.signal);
    let accepted = false;
    try {
      const after = await snapshot(ctx, call);
      const first = maskOutsideGrant(before, shot.image, shot.bounds);
      const second = maskOutsideGrant(after, shot.image, shot.bounds);
      for (let i = 0; i < first.keep.length; i++)
        first.keep[i] = (first.keep[i] ?? 0) & (second.keep[i] ?? 0);
      cover(shot.image, first.keep);
      call.signal.throwIfAborted();
      if (before.signature !== after.signature) continue;
      accepted = true;
      return { ...shot, masked: Math.max(first.masked, second.masked), keep: first.keep };
    } finally {
      if (!accepted) shot.image.data.fill(0);
    }
  }
  throw new ComputerError("target_moved", "screenshot_windows_changed");
}

function maskOutsideGrant(snapshot: Snapshot, image: RawImage, display: Rect) {
  const { windows } = snapshot;
  const shown = (window: WindowInfo) => {
    return snapshot.allowed.has(window.id);
  };
  const ordered = windows.every((w) => w.z !== undefined)
    ? windows
    : [...windows.filter(shown), ...windows.filter((w) => !shown(w))];
  const keep = new Uint8Array(image.width * image.height);
  let masked = 0;
  for (const window of ordered) {
    const hit = intersect(window.bounds, display);
    if (!hit) continue;
    const show = shown(window);
    if (!show) masked++;
    const r = clampRect(
      regionPixels({ ...hit, x: hit.x - display.x, y: hit.y - display.y }, display, image),
      image,
    );
    for (let row = r.y; row < r.y + r.height; row++) {
      const start = row * image.width + r.x;
      keep.fill(show ? 1 : 0, start, start + r.width);
    }
  }
  return { masked, keep };
}
