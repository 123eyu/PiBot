const suffix = String.raw`(?:/[^\s"'\x60$*?\[\]{};<>|&\\]*)?`;
const unquotedHome = new RegExp(`^\\$(?:HOME(?=/|$)|\\{HOME\\})(${suffix})$`);
const quotedHome = new RegExp(`^"\\$(?:HOME|\\{HOME\\})(/[^"\\\\$\x60]*)?"(${suffix})$`);

/** Only a single direct command can bind these words to the injected environment. */
export function homeArgument(text: string, home: string): string | undefined {
  const unquoted = unquotedHome.exec(text);
  if (unquoted) {
    // Unquoted variables undergo splitting and globbing, unlike tilde expansion.
    if (/[\s*?[\]\\]/u.test(home)) return;
    return home + (unquoted[1] ?? "");
  }
  const quoted = quotedHome.exec(text);
  if (quoted) return home + (quoted[1] ?? "") + (quoted[2] ?? "");
  return;
}
