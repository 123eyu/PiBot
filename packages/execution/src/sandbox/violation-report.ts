// The one fd-3 line a sandbox host sends exec with its proxy refusals. Shared by both
// ends so the sender's budget can never exceed the receiver's limit. Plain Node, erasable syntax:
// sandbox-host.ts loads it from source in development.

/** Longest accepted line, `violations ` included. */
export const VIOLATIONS_LINE_BYTES = 16 * 1024;
export const MAX_REPORTED_VIOLATIONS = 16;
export const MAX_VIOLATION_CHARS = 600;

/**
 * Newest entries first to survive: multi-byte text grows in UTF-8 and again in base64, so the
 * oldest are dropped until the encoded line fits rather than letting one report fail the command.
 */
export function violationsLine(lines: readonly string[]): string | undefined {
  const kept = lines
    .slice(-MAX_REPORTED_VIOLATIONS)
    .map((line) => line.slice(0, MAX_VIOLATION_CHARS));
  while (kept.length) {
    const line = `violations ${Buffer.from(JSON.stringify(kept)).toString("base64")}`;
    if (line.length <= VIOLATIONS_LINE_BYTES) return line;
    kept.shift();
  }
  return undefined;
}
