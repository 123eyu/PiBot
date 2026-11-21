// Subpaths: the title strip is part of the first frame, before the full kit / UI index loads.
import { hostPlatform } from "@pibot/renderer-kit/platform";
import { Logo } from "@pibot/ui/logo";
import styles from "./titlebar.module.css";

/**
 * Windows and Linux draw the window controls as a title bar overlay. Instead of letting them float
 * over the page (they overlapped header buttons), the app gives them a strip of their own across
 * the top (owner choice 2026-10-22, option B). macOS keeps its inline traffic lights.
 * When main falls back to the system title bar (overlay unavailable), the OS already draws a title
 * row with its controls, so a second strip of ours would duplicate it (maintainers 2026-11-13).
 * Main says which case this window is (preload `titleOverlay`). `windowControlsOverlay.visible`
 * was used before, but it is still false while the window is hidden, which is when this runs, so
 * Windows lost the strip and the controls covered the chat header's 新话题 and … (maintainers 2026-11-14).
 */
export const hasTitleStrip = () => {
  const platform = hostPlatform();
  if (platform !== "win32" && platform !== "linux") return false;
  // An older preload without the flag: keep the strip, as before the fallback existed.
  return window.pibotStartup?.titleOverlay ?? true;
};

/**
 * Only a name and the mark: the OS draws minimize / maximize / close in the overlay area, which the
 * strip leaves free (--window-controls-inset from env(titlebar-area-*)). Nothing here is clickable,
 * so the whole strip stays a drag region.
 */
export function WindowTitleBar() {
  return (
    <div className={styles.strip}>
      <Logo size={14} />
      <span className={styles.name}>Pi Bot</span>
    </div>
  );
}
