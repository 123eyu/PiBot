import type { BrowserViewDisplay } from "@pibot/browser-contract/full";
import { type RefObject, useEffect, useState } from "react";

const SETTLE_MS = 250;
/** Small jitter (scrollbars, rounding) would restart the stream for nothing. */
const MIN_CHANGE = 8;

/**
 * The frame box size in CSS pixels plus the device pixel ratio, settled after resizes (wide,
 * fullscreen, window drags). The host fits the page viewport and screencast to it.
 */
export function useFrameBox(element: RefObject<HTMLElement | null>, enabled: boolean) {
  const [box, setBox] = useState<BrowserViewDisplay | null>(null);
  useEffect(() => {
    const target = element.current;
    if (!enabled || !target) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const width = Math.round(target.clientWidth);
      const height = Math.round(target.clientHeight);
      if (width < 80 || height < 80) return;
      const scale = Math.min(4, Math.max(0.5, window.devicePixelRatio || 1));
      setBox((previous) =>
        previous &&
        Math.abs(previous.width - width) < MIN_CHANGE &&
        Math.abs(previous.height - height) < MIN_CHANGE &&
        previous.scale === scale
          ? previous
          : { width, height, scale },
      );
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, SETTLE_MS);
    });
    observer.observe(target);
    measure();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [element, enabled]);
  return box;
}
