// Same presets as the desktop avatar picker (packages/renderer-kit/src/widgets/bot-avatar.tsx),
// which the phone cannot import (it carries DOM components).
export const avatarShapes = [
  "blob",
  "pill",
  "drop",
  "pebble",
  "flower",
  "cloud",
  "ghost",
  "cat",
  "hex",
  "circle",
  "bean",
  "tri",
] as const;
export const avatarColors = [
  "orange",
  "amber",
  "blue",
  "violet",
  "pink",
  "teal",
  "green",
  "brown",
  "ink",
  "gray",
] as const;
export const avatarEyes = ["marks", "dot", "oval", "pixel", "sleepy"] as const;
