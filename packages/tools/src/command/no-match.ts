import type { CommandLiteralView } from "../runtime/tool-runtime.ts";

const SEARCH_PROGRAMS = new Set(["grep", "egrep", "fgrep", "rg"]);

/** `git grep` is a search too: Git reports "no match" with its own subcommand, not a program name. */
function programName(program: string): string {
  const base = program.split(/[/\\]/).at(-1) ?? program;
  return base.replace(/\.exe$/i, "");
}

/**
 * The search family a command line ends in, taken from its last pipeline segment only: that
 * segment decides both the exit code the shell reports and whether "nothing found" is a valid
 * answer. `find` is here because repeating it is just as pointless, but it prints nothing and
 * still exits 0 when it finds nothing, so only the repeat guard uses it.
 */
export function searchKind(
  analysis: { commands?: readonly CommandLiteralView[]; incomplete?: boolean } | undefined,
): "grep" | "find" | undefined {
  // A command the analyzer could not read completely has no proven meaning for either use.
  if (!analysis || analysis.incomplete) return undefined;
  const last = analysis.commands?.at(-1);
  if (!last) return undefined;
  const program = programName(last.program);
  if (SEARCH_PROGRAMS.has(program)) return "grep";
  if (program === "find") return "find";
  return program === "git" && last.args[0] === "grep" ? "grep" : undefined;
}

/**
 * Exit 1 from a search program means "no matches", not that the tool broke. Only a bare
 * exit 1 proves it: a real error (bad regex, unreadable path) exits 2 and writes stderr, and any
 * remaining output would be a match or that error text. The search program is the last segment, so
 * a pipeline ending in grep counts, while `grep … | head` keeps head's own exit code.
 */
export function searchNoMatch(
  analysis: { commands?: readonly CommandLiteralView[]; incomplete?: boolean } | undefined,
  exitCode: number | null,
  output: string,
): boolean {
  if (exitCode !== 1 || output.trim().length > 0) return false;
  return searchKind(analysis) === "grep";
}
