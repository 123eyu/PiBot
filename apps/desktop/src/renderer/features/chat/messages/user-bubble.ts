import type { AvatarColor } from "@pibot/ui";
import type { CSSProperties } from "react";

const colors = {
  orange: true,
  amber: true,
  blue: true,
  violet: true,
  pink: true,
  teal: true,
  green: true,
  brown: true,
  ink: true,
  gray: true,
} satisfies Record<AvatarColor, boolean>;

/**
 * The conversation's colour for the chat column: the user bubble plus `--chat-c` (fills,
 * washes, rings) and `--chat-ink` (text on the page) that cards, the composer and the hello state
 * read. A DM takes its Bot's colour; a group is teal, the same as its sidebar row.
 */
export function userBubbleStyle(
  avatarColor?: string,
  conversationKind: "dm" | "group" = "dm",
): CSSProperties {
  const color =
    conversationKind === "group"
      ? "teal"
      : avatarColor && Object.hasOwn(colors, avatarColor)
        ? avatarColor
        : "violet";
  return {
    "--userBubble": `var(--userBubble-${color})`,
    "--onUser": `var(--onUser-${color})`,
    "--chat-c": `var(--avatar-${color})`,
    "--chat-ink": `var(--ink-${color})`,
  } as CSSProperties;
}
