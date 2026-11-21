import { useLayoutEffect, useRef } from "react";
import type { ViewerProps } from "./engine.ts";
import styles from "./preview.module.css";
export default function ImageViewer({ file, result, update, fail, ready }: ViewerProps) {
  const host = useRef<HTMLDivElement>(null);
  const extension =
    "officeRender" in file.source ? "png" : file.name.toLowerCase().split(".").pop();
  const mime =
    result.kind === "svg"
      ? "image/svg+xml"
      : extension === "jpg" || extension === "jpeg"
        ? "image/jpeg"
        : `image/${extension}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore after the image has a layout
  useLayoutEffect(() => {
    host.current?.scrollTo(file.reading.x, file.reading.y);
  }, []);
  return (
    <div
      ref={host}
      className={styles.canvasHost}
      onScroll={(event) =>
        update(file.key, { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop })
      }
    >
      <img
        className={styles.image}
        style={{ width: `${Math.round(file.reading.zoom * 90)}%` }}
        src={`data:${mime};base64,${result.data}`}
        alt={file.name}
        onLoad={(event) => {
          if (event.currentTarget.naturalWidth * event.currentTarget.naturalHeight > 40_000_000)
            fail();
          else ready?.();
          host.current?.scrollTo(file.reading.x, file.reading.y);
        }}
        onError={fail}
      />
    </div>
  );
}
