import type { CSSProperties, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import styles from "./timeline.module.css";
import { stackTimelinePoints, type TimelinePoint } from "./timeline-points.ts";

export function TimelineTrack({
  points,
  describe,
  disabled,
  select,
  from,
  to,
  children,
}: {
  points: readonly TimelinePoint[];
  describe(point: TimelinePoint): { label: string; color: string };
  disabled: boolean;
  select(point: TimelinePoint): void;
  from?: string;
  to?: string;
  children: ReactNode;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = track.current;
    if (!node) return;
    const update = () => setWidth(node.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const layout = stackTimelinePoints(points, width);
  return (
    <div
      ref={track}
      className={styles.track}
      data-from={from}
      data-to={to}
      style={{ height: layout.height }}
    >
      {children}
      {layout.points.map((point) => {
        const { label, color } = describe(point);
        const tooltipWidth = Math.min(260, width || 260);
        const x = (point.position / 100) * width;
        const tooltipLeft =
          Math.max(0, Math.min(width - tooltipWidth, x - tooltipWidth / 2)) - x + 9;
        return (
          <button
            key={point.key}
            type="button"
            className={styles.mark}
            data-tone={point.tone}
            data-future={point.future || undefined}
            style={
              {
                left: `${point.position}%`,
                top: 8 + point.lane * 26,
                "--bot-color": `var(--avatar-${color})`,
                "--tooltip-width": `${tooltipWidth}px`,
                "--tooltip-left": `${tooltipLeft}px`,
              } as CSSProperties
            }
            title={label}
            aria-label={label}
            aria-disabled={(!!point.planned && disabled) || undefined}
            onClick={() => {
              if (!point.planned || !disabled) select(point);
            }}
          >
            <span className={styles.fill} aria-hidden />
            <span className={styles.tooltip} aria-hidden>
              {label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
