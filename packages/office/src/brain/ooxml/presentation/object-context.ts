import type { PresentationParts } from "./parts.ts";
import type { Placeholder } from "./template-read.ts";
import type { Box, Theme } from "./themes.ts";
export interface ObjectContext {
  parts: PresentationParts;
  slide: string;
  // A SmartArt block reserves several shape ids from the same slide-level sequence.
  ids: { next: () => number };
  width: number;
  height: number;
  theme: Theme;
  box: Box;
  placeholder?: Placeholder;
  images: Record<string, Uint8Array>;
  ordinal: number;
}
