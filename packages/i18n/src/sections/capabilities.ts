// Capabilities are not a user-facing concept (maintainers 2026-10-24): the only thing users see is
// that a connection overlapping a built-in tool yields to it.
export const capabilitiesZh = {
  "capabilities.builtinOverlap":
    "这个连接里有与内置「{capabilities}」重叠的工具，Bot 使用内置的，重叠的部分不会提供给 Bot。",
} as const;

export const capabilitiesEn: Record<keyof typeof capabilitiesZh, string> = {
  "capabilities.builtinOverlap":
    "Some tools in this connection overlap the built-in “{capabilities}”. Bots use the built-in tools; the overlapping ones are not offered to them.",
};
