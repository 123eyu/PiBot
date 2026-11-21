/**
 * Every code-map tool result carries reasons in one fixed shape — `code` or `code:count`.
 * The protocol caps each entry at 100 characters and the list at 30 entries; a detail such as a
 * path or a parser message made the whole tool call throw a ZodError, so the model got a crash
 * instead of an explanation. A code plus a count says the same thing in bounded space, and keeps
 * file names out of replies and logs.
 */
const MAX_REASON_LENGTH = 100;
const MAX_REASONS = 30;
/** A code is a fixed identifier; anything longer is not one, so it is clipped rather than trusted. */
const MAX_CODE_LENGTH = 48;

function codeOf(reason: string): string {
  const separator = reason.indexOf(":");
  const name = separator < 0 ? reason : reason.slice(0, separator);
  // Control characters would break the strict schema's one-line assumption and log parsing.
  return [...name.trim()]
    .filter((char) => {
      const point = char.codePointAt(0) ?? 0;
      return point > 0x1f && point !== 0x7f;
    })
    .join("")
    .slice(0, MAX_CODE_LENGTH);
}

function countOf(reason: string): number {
  const separator = reason.indexOf(":");
  if (separator < 0) return 1;
  const tail = reason.slice(separator + 1);
  return /^\d+$/.test(tail) ? Number(tail) : 1;
}

/**
 * Groups reasons by code and keeps their total, so hundreds of files hitting the same limit read
 * as one entry. An already summarized `code:count` survives unchanged, which lets a caller merge
 * the index's reasons with its own without counting them twice or losing the count.
 */
export function summarizeReasons(reasons: Iterable<string>): string[] {
  const counts = new Map<string, number>();
  for (const reason of reasons) {
    const code = codeOf(reason);
    if (!code) continue;
    counts.set(code, (counts.get(code) ?? 0) + countOf(reason));
  }
  return [...counts]
    .map(([code, count]) => (count > 1 ? `${code}:${count}` : code))
    .map((entry) => entry.slice(0, MAX_REASON_LENGTH))
    .slice(0, MAX_REASONS);
}
