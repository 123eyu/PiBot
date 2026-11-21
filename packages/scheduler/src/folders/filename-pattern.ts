import { FilenamePatternSchema } from "@pibot/protocol-base";

export function compileFilenamePattern(pattern: string) {
  const tokens = [...FilenamePatternSchema.parse(pattern).replace(/\*+/g, "*")];
  return (name: string, signal: AbortSignal, deadline = Infinity) => {
    signal.throwIfAborted();
    const chars = [...name];
    if (chars.length > 1024) throw new Error("watch_match_budget");
    let previous = new Uint8Array(chars.length + 1);
    previous[0] = 1;
    // At most 500 * 1024 cells per filename, two rows of bounded memory, no backtracking.
    for (const token of tokens) {
      signal.throwIfAborted();
      if (performance.now() > deadline) throw new Error("watch_scan_budget");
      const current = new Uint8Array(chars.length + 1);
      if (token === "*") current[0] = previous[0] ?? 0;
      for (let j = 1; j <= chars.length; j++) {
        current[j] =
          token === "*"
            ? previous[j] || current[j - 1]
              ? 1
              : 0
            : token === "?" || token === chars[j - 1]
              ? (previous[j - 1] ?? 0)
              : 0;
      }
      previous = current;
    }
    return previous[chars.length] === 1;
  };
}
