/**
 * Retain assignment names only; values never enter the output. A commented-out assignment
 * (`# NAME=`) stays a comment: templates ship optional keys that way, and dropping the line left
 * the saved example empty or unreadable.
 */
export function envExampleFilter() {
  let prefix = "",
    ignored = false;
  return (chunk: Uint8Array): string => {
    const lines: string[] = [];
    for (const byte of chunk) {
      if (byte === 10) {
        prefix = "";
        ignored = false;
        continue;
      }
      if (ignored) continue;
      if (byte === 61) {
        const match = /^(\s*#\s*)?(?:export\s+)?([A-Za-z_][A-Za-z0-9_]{0,127})\s*$/.exec(prefix);
        if (match?.[2]) lines.push(`${match[1] ?? ""}${match[2]}=\n`);
        prefix = "";
        ignored = true;
      } else if (prefix.length < 256 && byte < 128) prefix += String.fromCharCode(byte);
      else {
        prefix = "";
        ignored = true;
      }
    }
    return lines.join("");
  };
}
