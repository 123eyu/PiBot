import type { CommandInvocation } from "./types.ts";

/**
 * Programs that, given these options and no file operands, only transform the text on
 * stdin and write stdout. A listed `aws *` followed by `| head -20` runs head outside the sandbox
 * too; that is harmless only while head opens nothing. So every option is spelled out: anything
 * not listed (`-f`, `-o`, `-r`, `--files0-from`, rg `--pre`, …) or any extra operand keeps the
 * whole line sandboxed. `tee`, `xargs` and `jq` (its programs can `import` files and read `env`)
 * are never neutral.
 */
interface FilterShape {
  /** Single-letter flags without a value; may be bundled (`-rn`). */
  flags: string;
  /** Single-letter options that take a value, attached (`-n5`) or next (`-n 5`). */
  valued: string;
  /** Long options without a value. */
  long?: readonly string[];
  /** Long options with a value, `--name=v` or `--name v`. */
  longValued?: readonly string[];
  /** Long options whose value is optional: getopt only takes it attached (`--color=never`). */
  optional?: readonly string[];
  /** Non-option operands allowed: none of them names a file for these shapes. */
  operands: number;
  /** `head -20` / `tail -5`. */
  numeric?: true;
}

const HEAD_TAIL: FilterShape = {
  flags: "qv",
  valued: "nc",
  longValued: ["lines", "bytes"],
  long: ["quiet", "silent", "verbose"],
  operands: 0,
  numeric: true,
};
const GREP: FilterShape = {
  flags: "icvnoqsEFGwxhHaUzZ",
  valued: "eABCm",
  long: [
    "ignore-case",
    "invert-match",
    "count",
    "line-number",
    "only-matching",
    "quiet",
    "silent",
    "no-messages",
    "extended-regexp",
    "fixed-strings",
    "word-regexp",
    "line-regexp",
    "no-filename",
    "text",
  ],
  longValued: ["regexp", "max-count", "after-context", "before-context", "context"],
  optional: ["color", "colour"],
  operands: 1,
};
const SHAPES: Record<string, FilterShape> = {
  head: HEAD_TAIL,
  // No -f/-F: following keeps the line running; no files: tail reads stdin only.
  tail: HEAD_TAIL,
  wc: { flags: "lwcmL", valued: "", long: ["lines", "words", "bytes", "chars"], operands: 0 },
  // No -o/--output, -T, --files0-from, --compress-program.
  sort: {
    flags: "bdfghinMRrsuVc",
    valued: "kt",
    long: ["numeric-sort", "reverse", "unique", "human-numeric-sort", "version-sort"],
    longValued: ["key", "field-separator"],
    operands: 0,
  },
  uniq: { flags: "cdDiu", valued: "fsw", operands: 0 },
  cut: {
    flags: "nsz",
    valued: "bcdf",
    long: ["complement", "only-delimited"],
    longValued: ["bytes", "characters", "delimiter", "fields", "output-delimiter"],
    operands: 0,
  },
  // tr takes character sets, never files.
  tr: { flags: "cCdst", valued: "", operands: 2 },
  // GNU/Linux egrep/fgrep are scripts that exec bare `grep`: pinning their path still lets an
  // earlier PATH entry run. Use grep -E/-F. The remaining filters have native macOS/Linux binaries;
  // options that launch helpers (sort --compress-program, rg --pre/-z) are excluded above/below.
  grep: GREP,
  // rg with no path searches stdin when stdin is a pipe; no --pre, --files, -f, -r (replace is fine
  // but rare, left out), -z (decompressors), --ignore-file.
  rg: {
    flags: "icvnNoqFwxsSU",
    valued: "eABCm",
    long: [
      "ignore-case",
      "invert-match",
      "count",
      "line-number",
      "no-line-number",
      "only-matching",
      "quiet",
      "fixed-strings",
      "word-regexp",
      "line-regexp",
      "smart-case",
      "case-sensitive",
    ],
    longValued: ["regexp", "max-count", "after-context", "before-context", "context", "color"],
    operands: 1,
  },
  cat: { flags: "", valued: "", operands: 0 },
};

/**
 * True when this pipeline stage cannot open a file, run a program or keep running on its own.
 * Options must come first: BSD tools (macOS grep, sort, …) stop option parsing at the first
 * operand, so a later `-i` would be a file name there. After `--` or the first operand every word
 * is an operand, and operands are read per program: grep/rg take one pattern unless `-e` gave it,
 * tr one or two character sets, the rest none. `-` (stdin by name) is still an operand.
 */
export function neutralStdinFilter(invocation: CommandInvocation, program: string): boolean {
  const shape = Object.hasOwn(SHAPES, program) ? SHAPES[program] : undefined;
  if (!shape) return false;
  const args = invocation.args;
  let pattern = false;
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index] as string;
    if (arg === "--") {
      index++;
      break;
    }
    if (arg === "-" || !arg.startsWith("-")) break;
    if (arg.startsWith("--")) {
      const [name, value] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (shape.long?.includes(name) && value === undefined) continue;
      if (shape.optional?.includes(name)) continue;
      if (!shape.longValued?.includes(name)) return false;
      if (name === "regexp") pattern = true;
      if (value === undefined && ++index >= args.length) return false;
      continue;
    }
    if (shape.numeric && /^-\d+$/.test(arg)) continue;
    for (let at = 1; at < arg.length; at++) {
      const letter = arg[at] as string;
      if (shape.flags.includes(letter)) continue;
      if (!shape.valued.includes(letter)) return false;
      if (letter === "e") pattern = true;
      // The rest of the word is the value; otherwise the next word is.
      if (at === arg.length - 1 && ++index >= args.length) return false;
      break;
    }
  }
  const operands = args.length - index;
  if (program === "tr") return operands >= 1 && operands <= 2;
  return operands <= (pattern ? 0 : shape.operands);
}
