import { iconPaths } from "@pibot/ui/icon-paths";
import { Platform } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

// The desktop set (packages/ui Icon) plus the phone-only marks,
// drawn the same way: one path on a 24-unit grid, stroke 1.7, round caps and joins.
const phoneOnly = {
  laptop: "M5 5h14v10H5ZM2.5 19h19",
  face: "M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3M9 9v1.5M15 9v1.5M12 9v4h-1M9 16c1.7 1.3 4.3 1.3 6 0",
  lock: "M5 11h14v10H5ZM8 11V8a4 4 0 0 1 8 0v3",
  up: "M12 20V5M6 11l6-6 6 6",
  qr: "M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4ZM14 14h2v2h-2ZM18 14h2v2h-2ZM14 18h2v2h-2ZM18 18h2v2h-2Z",
  bell: "M6 16v-5a6 6 0 0 1 12 0v5l2 2H4ZM10 21h4",
  pause: "M9 5v14M15 5v14",
  share: "M12 3v12M7 8l5-5 5 5M5 13v8h14v-8",
  save: "M12 3v12M7 10l5 5 5-5M5 21h14",
  openwith: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  keyboard: "M3 6h18v12H3ZM7 10h.01M11 10h.01M15 10h.01M7 14h10",
  minus: "M5 12h14",
  camera: "M3 8h4l2-3h6l2 3h4v11H3ZM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
  // Device list: a phone, and a runner as stacked server units.
  phone: "M8 3h8v18H8ZM11 18h2",
  server: "M4 5h16v6H4ZM4 13h16v6H4ZM8 8h.01M8 16h.01",
} as const;
const icons = { ...iconPaths, ...phoneOnly };
export type IconName = keyof typeof icons;

/** Sizes from the mapping: 18 in rows and buttons, 22 in navigation, 24 in the tab bar. */
export function Icon({
  name,
  color,
  size = 18,
  strokeWidth = 1.7,
}: {
  name: IconName;
  color: string;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}>
      <Path
        // Android unlocks with a fingerprint or the screen lock, never a face scan.
        d={icons[name === "face" && Platform.OS === "android" ? "lock" : name]}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
/** The filled square on the stop button. */
export function StopGlyph({ color }: { color: string }) {
  return (
    <Svg width={14} height={14} viewBox="0 0 14 14" accessible={false}>
      <Rect x={1} y={1} width={12} height={12} rx={2.5} fill={color} />
    </Svg>
  );
}
