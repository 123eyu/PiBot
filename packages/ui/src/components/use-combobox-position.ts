import { type CSSProperties, type RefObject, useLayoutEffect, useState } from "react";

export function useComboboxPosition(
  open: boolean,
  trigger: RefObject<HTMLElement | null>,
  minWidth = 0,
) {
  const [position, setPosition] = useState<CSSProperties>();
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const element = trigger.current;
    const update = () => {
      const rect = element.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const below = Math.max(0, window.innerHeight - rect.bottom - margin - gap);
      const above = Math.max(0, rect.top - margin - gap);
      const upward = below < 280 && above > below;
      // Pill/badge triggers are narrower than their options; matching their width wrapped every label.
      const width = Math.min(
        Math.max(rect.width, minWidth),
        Math.max(0, window.innerWidth - margin * 2),
      );
      // A trigger on the right half (row-end pills) grows the list leftwards from its right edge,
      // so the list stays under the trigger instead of jumping to the clamped viewport edge.
      const start =
        rect.left + rect.width / 2 > window.innerWidth / 2 ? rect.right - width : rect.left;
      setPosition({
        left: Math.max(margin, Math.min(start, window.innerWidth - width - margin)),
        width,
        top: upward ? undefined : Math.max(margin, rect.bottom + gap),
        bottom: upward ? Math.max(margin, window.innerHeight - rect.top + gap) : undefined,
        maxHeight: Math.min(400, upward ? above : below),
      });
    };
    update();
    // Capture ancestor scrolling too: the portal no longer shares the trigger's scroll container.
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
      observer.disconnect();
    };
  }, [open, trigger, minWidth]);
  return position;
}
