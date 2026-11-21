import { avatarColor, type Colors, userBubble } from "./use-theme.ts";

/**
 * "Immersive colour": every page carries one colour from the Bot avatar palette. Tabs have a
 * fixed one; a Bot's pages use its avatar colour and a group's pages the group colour.
 */
export const TAB_TINT = {
  chat: "violet",
  todos: "blue",
  tasks: "orange",
  approvals: "amber",
  devices: "teal",
} as const;
export const GROUP_TINT = "pink";
export type TabName = keyof typeof TAB_TINT;

export interface Tint {
  /** The bright avatar fill: the page wash, icon dots and other large marks. */
  wash: string;
  /** A fill that carries white text (the user's bubble, the send button, chosen checks). */
  fill: string;
  onFill: string;
  /** Text and thin marks in the colour on the page background or on glass. */
  ink: string;
}
export function tintOf(colors: Colors, name: string | undefined): Tint {
  const key = name && Object.hasOwn(colors, `ink-${name}`) ? name : "violet";
  const bubble = userBubble(colors, key);
  return {
    wash: avatarColor(colors, key),
    fill: bubble.bg,
    onFill: bubble.fg,
    ink: colors[`ink-${key}` as keyof Colors],
  };
}
/**
 * A token colour at a lower opacity, for washes and rims mixed from the page colour. Tokens of
 * other forms (already translucent) are returned unchanged.
 */
export function withAlpha(color: string, alpha: number) {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const byte = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `${color}${byte.toString(16).padStart(2, "0")}`;
}
