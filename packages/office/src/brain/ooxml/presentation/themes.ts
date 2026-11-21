import type {
  PresentationLayoutId,
  PresentationThemeId,
} from "@pibot/protocol-base/office-content";

export const WIDTH = 12_192_000;
export const HEIGHT = 6_858_000;
export type Box = { x: number; y: number; width: number; height: number };

function luminance(hex: string) {
  const channels = [0, 2, 4].map((index) => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}
function contrast(left: string, right: string) {
  const a = luminance(left),
    b = luminance(right);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function mix(from: string, to: string, amount: number) {
  return [0, 2, 4]
    .map((index) =>
      Math.round(
        parseInt(from.slice(index, index + 2), 16) * (1 - amount) +
          parseInt(to.slice(index, index + 2), 16) * amount,
      )
        .toString(16)
        .padStart(2, "0")
        .toUpperCase(),
    )
    .join("");
}
/**
 * Page numbers are small and repeated on every slide, so an imported template's light `dk2`
 * used to fail the deck's own contrast check. Move the color toward black or white until it
 * reaches WCAG AA instead of trusting the template's muted tone.
 */
export function readableOn(foreground: string, background: string, target = 4.5) {
  const hex = (value: string) => /^[a-f0-9]{6}$/i.test(value);
  if (!hex(foreground) || !hex(background)) return foreground;
  if (contrast(foreground, background) >= target) return foreground;
  const away = luminance(background) > 0.5 ? "000000" : "FFFFFF";
  let result = foreground;
  for (let step = 1; step <= 20 && contrast(result, background) < target; step++)
    result = mix(foreground, away, step / 20);
  return result;
}
type Colors = [string, string, string, string, string, string];
export interface Theme {
  name: string;
  background: string;
  section: string;
  ink: string;
  muted: string;
  paper: string;
  onSection: string;
  colors: Colors;
  heading: string;
  body: string;
  eastAsia: string;
  margin: number;
  gap: number;
  decoration: "rail" | "band" | "rule" | "none";
}

export const themes: Record<PresentationThemeId, Theme> = {
  classic: {
    name: "Classic",
    background: "F7F9FC",
    section: "244568",
    ink: "202838",
    muted: "475A70",
    paper: "E8EFF8",
    onSection: "FFFFFF",
    colors: ["244568", "287A8E", "A15029", "594E9B", "527244", "B93752"],
    heading: "Arial",
    body: "Arial",
    eastAsia: "Microsoft YaHei",
    margin: 0.055,
    gap: 0.035,
    decoration: "rail",
  },
  midnight: {
    name: "Midnight",
    background: "10192C",
    section: "25204A",
    ink: "F4F6FF",
    muted: "BAC7E2",
    paper: "24314C",
    onSection: "FFFFFF",
    colors: ["A5A9FF", "64DBC9", "FFBE84", "F490BA", "B8DF7A", "82BDFF"],
    heading: "Aptos Display",
    body: "Aptos",
    eastAsia: "Microsoft YaHei",
    margin: 0.065,
    gap: 0.045,
    decoration: "band",
  },
  editorial: {
    name: "Editorial",
    background: "FFF9EE",
    section: "70362D",
    ink: "382824",
    muted: "675147",
    paper: "F5E6D8",
    onSection: "FFFFFF",
    colors: ["963D32", "336A72", "916424", "6B5279", "596A46", "3E5A88"],
    heading: "Georgia",
    body: "Georgia",
    eastAsia: "SimSun",
    margin: 0.075,
    gap: 0.05,
    decoration: "rule",
  },
  forest: {
    name: "Forest",
    background: "F3F8F1",
    section: "214C40",
    ink: "19332B",
    muted: "435F52",
    paper: "DFEDE3",
    onSection: "FFFFFF",
    colors: ["286652", "527443", "885828", "3F638A", "7B4A73", "AF5044"],
    heading: "Trebuchet MS",
    body: "Arial",
    eastAsia: "Microsoft YaHei",
    margin: 0.06,
    gap: 0.04,
    decoration: "rail",
  },
  studio: {
    name: "Studio",
    background: "FFF7F3",
    section: "5B2569",
    ink: "321D3F",
    muted: "684967",
    paper: "F4E1ED",
    onSection: "FFFFFF",
    colors: ["8A327A", "A54934", "216F74", "55448C", "496935", "905723"],
    heading: "Aptos Display",
    body: "Arial",
    eastAsia: "Microsoft YaHei",
    margin: 0.07,
    gap: 0.045,
    decoration: "band",
  },
  minimal: {
    name: "Minimal",
    background: "FFFFFF",
    section: "222222",
    ink: "202020",
    muted: "555555",
    paper: "EEEEEE",
    onSection: "FFFFFF",
    colors: ["202020", "32607C", "96532F", "4C6C54", "78577D", "6F6351"],
    heading: "Helvetica",
    body: "Arial",
    eastAsia: "Microsoft YaHei",
    margin: 0.08,
    gap: 0.055,
    decoration: "none",
  },
};

export const layoutDefinitions = {
  cover: ["Cover", "title"],
  agenda: ["Agenda", "cust"],
  section: ["Section", "secHead"],
  "title-body": ["Title and Body", "tx"],
  "two-column": ["Two Columns", "twoColTx"],
  "image-text": ["Image and Text", "picTx"],
  "full-image": ["Full Image", "blank"],
  chart: ["Chart", "chart"],
  table: ["Table", "tbl"],
  quote: ["Quote", "cust"],
  closing: ["Closing", "cust"],
} as const satisfies Record<PresentationLayoutId, readonly [string, string]>;
export const layouts = Object.keys(layoutDefinitions) as PresentationLayoutId[];

export interface SlideGrid {
  title?: Box;
  text?: Box;
  secondary?: Box;
  object: Box;
  subtitle?: Box;
  titleSize: number;
  bodySize: number;
  section?: boolean;
  centered?: boolean;
}

export const rect = (x: number, y: number, width: number, height: number): Box => ({
  x,
  y,
  width,
  height,
});
export function slideGrid(theme: Theme, layout: PresentationLayoutId): SlideGrid {
  const m = theme.margin;
  const w = 1 - 2 * m;
  const column = (w - theme.gap) / 2;
  const base = {
    title: rect(m, 0.085, w, 0.14),
    text: rect(m, 0.25, w, 0.56),
    object: rect(m, 0.3, w, 0.56),
    subtitle: rect(m, 0.21, w, 0.07),
    titleSize: 30,
    bodySize: 19,
  };
  switch (layout) {
    case "cover":
      return {
        ...base,
        title: rect(m, 0.26, w, 0.24),
        subtitle: rect(m, 0.53, w, 0.1),
        text: rect(m, 0.66, w, 0.13),
        titleSize: 46,
        section: true,
      };
    case "section":
      return {
        ...base,
        title: rect(m, 0.34, w, 0.2),
        subtitle: rect(m, 0.57, w, 0.09),
        text: rect(m, 0.69, w, 0.12),
        titleSize: 42,
        section: true,
      };
    case "agenda":
      return { ...base, text: rect(m + 0.05, 0.27, w - 0.05, 0.56), bodySize: 22 };
    case "two-column":
      return {
        ...base,
        text: rect(m, 0.28, column, 0.55),
        secondary: rect(m + column + theme.gap, 0.28, column, 0.55),
        object: rect(m + column + theme.gap, 0.28, column, 0.55),
      };
    case "image-text":
      return {
        ...base,
        text: rect(m, 0.3, column, 0.54),
        object: rect(m + column + theme.gap, 0.27, column, 0.57),
      };
    case "full-image":
      return {
        ...base,
        title: rect(m, 0.83, w, 0.12),
        text: rect(m, 0.71, w, 0.09),
        subtitle: rect(m, 0.94, w, 0.05),
        object: rect(0, 0, 1, 1),
        titleSize: 24,
        bodySize: 14,
        section: true,
      };
    case "chart":
    case "table":
      return {
        ...base,
        text: rect(m, 0.25, w, 0.065),
        object: rect(m, 0.33, w, 0.54),
        bodySize: 14,
      };
    case "quote":
      return {
        ...base,
        text: rect(m + 0.09, 0.32, w - 0.18, 0.3),
        subtitle: rect(m + 0.09, 0.69, w - 0.18, 0.1),
        bodySize: 34,
        centered: true,
      };
    case "closing":
      return {
        ...base,
        title: rect(m, 0.33, w, 0.19),
        subtitle: rect(m, 0.55, w, 0.1),
        text: rect(m, 0.67, w, 0.13),
        titleSize: 44,
        section: true,
        centered: true,
      };
    default:
      return base;
  }
}
