import type { BrowserElementSummary } from "@pibot/browser-contract/full";
import { type CSSProperties, type RefObject, useLayoutEffect, useState } from "react";
import styles from "./bot-browser.module.css";
import { frameRect } from "./frame-fit.ts";
import type { FrameMeta } from "./use-browser-frames.ts";

/** Inverse of framePoint: map page CSS pixels into the contained image, including letterboxing. */
export function elementBox(
  frame: { width: number; height: number },
  image: { width: number; height: number },
  view: { width: number; height: number },
  bounds: { x: number; y: number; width: number; height: number },
) {
  const fit = frameRect(view, image);
  if (!fit) return undefined;
  const left = Math.max(0, Math.min(frame.width, bounds.x)),
    top = Math.max(0, Math.min(frame.height, bounds.y));
  const right = Math.max(left, Math.min(frame.width, bounds.x + bounds.width)),
    bottom = Math.max(top, Math.min(frame.height, bounds.y + bounds.height));
  return {
    left: fit.left + (left / frame.width) * fit.width,
    top: fit.top + (top / frame.height) * fit.height,
    width: ((right - left) / frame.width) * fit.width,
    height: ((bottom - top) / frame.height) * fit.height,
  };
}
export function ElementOutline({
  element,
  meta,
  canvas,
}: {
  element: BrowserElementSummary;
  meta: FrameMeta;
  canvas: RefObject<HTMLCanvasElement | null>;
}) {
  const [position, setPosition] = useState<CSSProperties>();
  useLayoutEffect(() => {
    const node = canvas.current;
    if (!node || !element.bounds) return;
    const place = () => {
      if (!element.bounds) return;
      const rect = node.getBoundingClientRect();
      setPosition(
        elementBox(
          meta,
          { width: meta.imageWidth, height: meta.imageHeight },
          rect,
          element.bounds,
        ),
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(node);
    return () => observer.disconnect();
  }, [element, meta, canvas]);
  return position ? (
    <div className={styles.elementOutline} style={position}>
      <span>
        {element.tag} {element.name}
      </span>
    </div>
  ) : null;
}
