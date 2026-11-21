import { basename, extname } from "node:path";
import { containsPath } from "@pibot/policy";

/**
 * What counts as "changed code". Source files only: docs, data and lock files do not
 * start a check. Build files that decide how code is checked (Makefile …) count too.
 */
export const DEFAULT_CODE_EXTENSIONS: readonly string[] = [
  ".c",
  ".cc",
  ".cjs",
  ".clj",
  ".cpp",
  ".cs",
  ".css",
  ".cts",
  ".dart",
  ".ex",
  ".exs",
  ".fs",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".less",
  ".lua",
  ".m",
  ".mjs",
  ".mm",
  ".mts",
  ".php",
  ".pl",
  ".ps1",
  ".py",
  ".r",
  ".rb",
  ".rs",
  ".scala",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
  ".zig",
];
const BUILD_FILES = new Set(["makefile", "gnumakefile", "cmakelists.txt", "build.gradle"]);

/** Changed code files under `folder`; one pass with a Set lookup per path. */
export function codeChanges(
  paths: readonly string[],
  folder: string,
  platform: "darwin" | "linux" | "win32",
  extensions: ReadonlySet<string>,
): string[] {
  return paths.filter((path) => {
    const name = basename(path).toLowerCase();
    return (
      (extensions.has(extname(name)) || BUILD_FILES.has(name)) &&
      containsPath(folder, path, platform)
    );
  });
}

/** The last `lines` lines of command output, at most `chars` characters (whole lines kept). */
export function outputTail(text: string, lines: number, chars: number): string {
  const kept = text
    .replace(/\r\n?/g, "\n")
    .replace(/^\s*\n|\n+$/g, "")
    .split("\n")
    .slice(-lines);
  while (kept.length > 1 && kept.join("\n").length > chars) kept.shift();
  const tail = kept.join("\n");
  return tail.length > chars ? tail.slice(-chars) : tail;
}
