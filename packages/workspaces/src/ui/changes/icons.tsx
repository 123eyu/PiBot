import type { SVGProps } from "react";

/** Icons only the changes sidebar uses; same stroke style as @pibot/ui Icon. */
const paths = {
  branch:
    "M3.5 6a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M3.5 18a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M15.5 8a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M6 8.5v7M18 10.5c0 4-6 3-11 5.5",
  undo: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  sparkle: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6",
  comment: "M4 5h16v11H9l-5 4Z",
  expand: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7",
  shrink: "M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7",
  wrap: "M4 6h16M4 12h13a3 3 0 0 1 0 6h-4M15 16l-2 2 2 2M4 18h5",
  tree: "M4 5h6M8 12h12M8 19h12M6 5v14",
  flat: "M5 6h14M5 12h14M5 18h14",
  back: "m15 6-6 6 6 6",
  right: "m9 6 6 6-6 6",
  up: "m6 15 6-6 6 6",
  down: "m6 9 6 6 6-6",
  open: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  lock: "M5 11h14v9H5ZM8 11V8a4 4 0 0 1 8 0v3",
  plus: "M12 5v14M5 12h14",
  check: "m5 12 5 5 9-10",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12ZM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0",
} as const;

export type ChangesIconName = keyof typeof paths;
export function ChangesIcon({
  name,
  size = 14,
  ...props
}: SVGProps<SVGSVGElement> & { name: ChangesIconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
