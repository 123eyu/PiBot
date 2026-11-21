import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@pibot/observability";
import { DesktopStateSchema } from "@pibot/protocol-base/desktop-state";

export interface Bounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}
export interface DesktopState {
  bounds: Bounds;
  closeToTrayHintShown: boolean;
  openAtLogin: boolean | undefined;
}

export function restoreBounds(value: unknown, displays: readonly Bounds[]): Bounds {
  const fallback = { width: 1280, height: 800 };
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Record<string, unknown>;
  const { x, y, width, height } = candidate;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 960 ||
    height < 640
  )
    return fallback;
  const bounds = { width: Math.round(width), height: Math.round(height) };
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y))
    return bounds;
  const visible = displays.some(
    (display) =>
      x + width > (display.x ?? 0) + 80 &&
      x < (display.x ?? 0) + display.width - 80 &&
      y >= (display.y ?? 0) &&
      y < (display.y ?? 0) + display.height - 80,
  );
  return visible ? { ...bounds, x: Math.round(x), y: Math.round(y) } : bounds;
}

export function desktopState(dataDir: string, displays: readonly Bounds[], logger: Logger) {
  const file = join(dataDir, "desktop-state.json");
  let saved: Partial<DesktopState> = {};
  try {
    saved = DesktopStateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      logger.warn("desktop state unreadable or invalid, using defaults");
  }
  const state: DesktopState = {
    bounds: restoreBounds(saved.bounds, displays),
    closeToTrayHintShown: saved.closeToTrayHintShown === true,
    // Bounds may be saved before brain settings arrive; unknown must not unregister login.
    openAtLogin: saved.openAtLogin,
  };
  return {
    state,
    save() {
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
      renameSync(temporary, file);
    },
  };
}
