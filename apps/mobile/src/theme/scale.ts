import { Platform, type TextStyle, type ViewStyle } from "react-native";
import { type Colors, monoFont } from "./use-theme.ts";

// The desktop → phone mapping: the desktop renderer's type,
// radii and spacing, with body sizes one point larger for the phone. No `fontFamily`, so both
// platforms use their system font as the desktop does (SF / PingFang, Roboto / Noto Sans CJK).
// The desktop's 650 weight has no RN equivalent between "600" and "700"; it maps to "600".
const text = (
  fontSize: number,
  lineHeight: number,
  fontWeight: TextStyle["fontWeight"] = "400",
): TextStyle => ({ fontSize, lineHeight, fontWeight });
export const type = {
  /** Tab page titles: large, on the colour wash. */
  tabTitle: text(26, 32, "700"),
  /** Summary numbers on the chat and task tabs. */
  stat: text(20, 26, "700"),
  /** Pushed page and chat header names (desktop chat header 15/650). */
  headName: text(16, 21, "600"),
  headSub: text(12.5, 17),
  /** Sidebar-style list names. */
  listName: text(16, 21, "600"),
  preview: text(14, 19),
  body: text(15, 22),
  bodyStrong: text(15, 22, "600"),
  /** Settings row title and value. */
  rowTitle: text(15, 20, "600"),
  rowValue: text(14, 19),
  /** Section headings above a card (renderer-kit settings layout). */
  section: text(13, 20, "600"),
  sheetTitle: text(17, 24, "600"),
  tool: text(13.5, 19),
  button: text(15, 20, "600"),
  pill: text(13.5, 18, "500"),
  chip: text(13, 18),
  caption: text(12.5, 18),
  small: text(12, 18),
  time: text(11.5, 15),
  tab: text(11, 14),
  input: text(16, 22),
  emptyTitle: text(16, 22, "600"),
} as const;
export const mono = (fontSize = 13) =>
  ({ fontFamily: monoFont, fontSize, lineHeight: Math.round(fontSize * 1.5) }) satisfies TextStyle;

export const radius = {
  row: 12,
  card: 16,
  /** Cards of rows (ListCard) and the approval cards. */
  panel: 20,
  pill: 999,
  /** Question / plan cards (desktop execution cards). */
  soft: 14,
  bubble: 18,
  /** The pointed corner of a chat bubble, on the sender's side at the bottom. */
  tail: 6,
  composer: 25,
  code: 10,
  tag: 6,
  sheet: 16,
} as const;
export const space = {
  page: 16,
  messageGap: 16,
  rowPad: 10,
  rowInset: 8,
  settingsRow: 56,
} as const;
/** Smallest touch target; smaller controls widen to it with `hitSlop`. */
export const TOUCH = 44;
export const slopFor = (size: number) => {
  const pad = Math.max(0, (TOUCH - size) / 2);
  return { top: pad, bottom: pad, left: pad, right: pad };
};

/**
 * The desktop `--shadow` (0 1px 3px, 12% black). iOS takes the token's colour with its alpha and
 * full opacity; Android has only elevation, and 1 is the closest step.
 */
export function cardShadow(colors: Colors): ViewStyle {
  const shadowColor = colors.shadow.split(" ").at(-1) ?? colors.text;
  return Platform.select<ViewStyle>({
    ios: { shadowColor, shadowOpacity: 1, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
    default: { elevation: 1 },
  });
}
/** Popovers over content (desktop `--pop`, 0 4px 16px); the overlay token keeps it dark in both themes. */
export function popShadow(colors: Colors): ViewStyle {
  return Platform.select<ViewStyle>({
    ios: {
      shadowColor: colors.overlay,
      shadowOpacity: 0.25,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 4 },
    },
    default: { elevation: 4 },
  });
}
