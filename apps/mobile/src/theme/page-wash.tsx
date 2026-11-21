import { useId } from "react";
import { StyleSheet } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

/**
 * The colour layer behind a page header: the page colour mixed about 24% into the
 * background at the top, fading to the background itself (the sketch's 170° CSS gradient).
 * Drawn as an alpha ramp over the page background, which is the same mix in both themes.
 */
export function PageWash({ color }: { color: string }) {
  // Gradient ids are document-wide on some react-native-svg backends; never share one.
  const id = `wash${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <Svg
      style={StyleSheet.absoluteFill}
      width="100%"
      height="100%"
      pointerEvents="none"
      accessible={false}
    >
      <Defs>
        <LinearGradient id={id} x1="0.4" y1="0" x2="0.58" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity={0.24} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}
/** The glass sheen: a bright top edge fading out by the middle, as light on a curved pane. */
/**
 * SVG gradient stops ignore the alpha byte of an 8-digit hex colour, so the dark theme's faint
 * sheen (#ffffff26) rendered as opaque white ("chrome" bar). Split it into colour + opacity.
 */
function splitAlpha(color: string) {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(color);
  return match
    ? { color: `#${match[1]}`, opacity: Number.parseInt(match[2] ?? "ff", 16) / 255 }
    : { color, opacity: 1 };
}
export function GlassSheen({ color: token }: { color: string }) {
  const id = `sheen${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const { color, opacity } = splitAlpha(token);
  return (
    <Svg
      style={StyleSheet.absoluteFill}
      width="100%"
      height="100%"
      pointerEvents="none"
      accessible={false}
    >
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={color} stopOpacity={opacity} />
          <Stop offset="0.55" stopColor={color} stopOpacity={0.12 * opacity} />
          <Stop offset="1" stopColor={color} stopOpacity={0.36 * opacity} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}
