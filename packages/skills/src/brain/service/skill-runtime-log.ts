import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createRedactor } from "@pibot/secrets";

/** Execution output is already stream-redacted; scrub again before a bounded diagnostic copy. */
export function runtimeOutputTail(
  text: string,
  roots: { dataDir: string; venv: string; skill: string },
  redact?: (text: string) => string,
): string {
  const plain = stripVTControlCharacters(text);
  let safe = createRedactor().redact(redact ? redact(plain) : plain);
  safe = safe
    .replace(/\b(?:Bearer|Basic)\s+[a-z0-9+/=_.,-]+/gi, "[REDACTED AUTH]")
    .replace(
      /\b(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
      try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[URL]";
      }
    });
  const paths = [
    [roots.venv, "<venv>"],
    [roots.skill, "<skill>"],
    [join(roots.dataDir, "runtimes", "python"), "<managed-python>"],
    [join(roots.dataDir, "runtimes", "uv"), "<uv>"],
    [join(roots.dataDir, "runtimes", "uv-cache"), "<cache>"],
    [roots.dataDir, "<managed-root>"],
  ] as const;
  for (const [path, category] of [...paths].sort((a, b) => b[0].length - a[0].length))
    safe = safe.replaceAll(path, category);
  // Both limits apply after scrubbing, so cutting a long line cannot expose part of a secret.
  return Buffer.from(safe.replace(/\r\n?/g, "\n").split("\n").slice(-40).join("\n"))
    .subarray(-(16 * 1024 - 4))
    .toString("utf8")
    .trim();
}
