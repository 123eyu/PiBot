import { tokens } from "@pibot/ui/tokens";
import { Platform, StyleSheet } from "react-native";
import { useDisplay } from "./display.tsx";

export type Colors = Record<keyof (typeof tokens)["light"], string>;
// RN cannot read the CSS font stacks in the tokens; these are the platform equivalents.
export const monoFont = Platform.select({ ios: "Menlo", default: "monospace" });

export function useColors(): Colors {
  return tokens[useDisplay().scheme];
}
/** A Bot avatar color name from the desktop palette; unknown names fall back to violet. */
export function avatarColor(colors: Colors, name: string) {
  const key = `avatar-${name}`;
  return Object.hasOwn(colors, key) ? colors[key as keyof Colors] : colors["avatar-violet"];
}
/**
 * The user's bubble: the Bot's colour, deepened (`userBubble-{color}`), with its text colour; a
 * group chat passes "violet". Unknown names fall back to violet as the avatars do.
 */
export function userBubble(colors: Colors, name: string) {
  const key = Object.hasOwn(colors, `userBubble-${name}`) ? name : "violet";
  return {
    bg: colors[`userBubble-${key}` as keyof Colors],
    fg: colors[`onUser-${key}` as keyof Colors] ?? colors.onUser,
  };
}
/**
 * Text/glyph color on saturated fills (danger badge, stop button, done mark). The tokens have no
 * `onDanger`; the avatar eye is the palette's fixed white in both themes, as the design uses.
 */
export function onFill(colors: Colors) {
  return colors["avatar-eye"];
}
export function useTheme() {
  const colors = useColors();
  const styles = StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.bg },
    content: { padding: 16, gap: 12 },
    text: { color: colors.text },
    muted: { color: colors.text2 },
    error: { color: colors.danger },
  });
  return { colors, styles };
}
