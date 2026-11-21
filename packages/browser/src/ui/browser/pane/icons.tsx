import type { SVGProps } from "react";

// Overlay-only glyphs, drawn in the same 24px stroke style as @pibot/ui Icon.
const paths = {
  globe:
    "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17M3.5 12h17M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17",
  back: "M15 6l-6 6 6 6",
  reload: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  hand: "M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v7c0 4-2.5 7-6 7-2.5 0-4-1.2-5.5-3.5L4 13.5a1.5 1.5 0 0 1 2.6-1.5L8 14",
  expand: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7",
  shrink: "M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7",
  lock: "M5 11h14v9H5ZM8 11V8a4 4 0 0 1 8 0v3",
  close: "M6 6l12 12M6 18L18 6",
  plus: "M12 5v14M5 12h14",
  alert: "M12 4 21 20H3ZM12 10v4.5M12 17.2v.3",
} as const;

export type BrowserIconName = keyof typeof paths;

export function BrowserIcon({
  name,
  size = 15,
  ...props
}: SVGProps<SVGSVGElement> & { name: BrowserIconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
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
