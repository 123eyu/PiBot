/**
 * Bot names are unique among non-archived Bots. Two names are the same when they match
 * after trimming, NFKC (full-width/half-width and compatibility forms) and lower-casing, so
 * 「Ｐｉ」, "pi " and "Pi" cannot live side by side. Shared by brain, store and the window.
 */
export const BOT_NAME_MAX = 200;

export function botNameKey(name: string): string {
  return name.trim().normalize("NFKC").toLowerCase();
}

/** 「name 2」, 「name 3」…: the base is shortened so the result still fits the name limit. */
export function numberedBotName(base: string, n: number): string {
  const suffix = ` ${n}`;
  const head = Array.from(base.trim())
    .slice(0, BOT_NAME_MAX - suffix.length)
    .join("")
    .trimEnd();
  return `${head}${suffix}`;
}

/**
 * The first free name for `base` (itself, else 「base 2」, 「base 3」…) given the keys already in
 * use. Does not add the result to `taken`.
 */
export function freeBotName(base: string, taken: ReadonlySet<string>): string {
  const trimmed = base.trim();
  if (!taken.has(botNameKey(trimmed))) return trimmed;
  for (let n = 2; ; n++) {
    const candidate = numberedBotName(trimmed, n);
    if (!taken.has(botNameKey(candidate))) return candidate;
  }
}
