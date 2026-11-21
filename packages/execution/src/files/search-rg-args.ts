import type { RgCleanupCode } from "./search-rg-process.ts";
import { MAX_DEPTH, SKIPPED_DIRECTORIES } from "./search-walk.ts";

/**
 * The bundled rg only decides WHICH files the search looks at. It walks the authorized
 * root natively (the slow part of the JS engine), but every path it prints goes through the same
 * per-folder authorization and the same checked JS read as a walked file before anything is
 * returned. So rg reading something it should not have (a race, a hard link, a protected
 * subfolder) cannot publish a byte: it can at most add a candidate that the JS checks then drop.
 */
export interface SearchEngine {
  /** The checked rg executable of this target; rejects when the target has none. */
  executable(): Promise<string>;
  /** Fixed code only: the log says why a search ran on JS, never a path or query. */
  fallback(code: "search_rg_unavailable" | "search_rg_failed"): void;
  /** An rg that could not be confirmed gone (and, later, that it did go): every time, not once. */
  cleanup(code: RgCleanupCode): void;
}

export function createSearchEngine(
  executable: () => Promise<string>,
  report: (code: string) => void,
): SearchEngine {
  // A target without rg would otherwise log on every search; one line per cause is enough.
  const reported = new Set<string>();
  return {
    executable,
    fallback(code) {
      if (reported.has(code)) return;
      reported.add(code);
      report(code);
    },
    cleanup: report,
  };
}

// Mirrors the JS walker's rule so rg does not even read these trees. rgWalk re-applies
// skippedDirectory() to every printed path, so these globs only have to be a safe superset.
const SOURCE_HIDDEN_NAMES = ["github", "gitlab", "storybook", "changeset"];

/**
 * rg globs cannot re-include a folder after `!.*\/` without switching every glob to whitelist
 * mode, so hidden folders are excluded by a prefix trie that spells out "every dot-name except
 * the kept ones" with negated character classes.
 */
function hiddenDirectoryGlobs(prefix = "", names = SOURCE_HIDDEN_NAMES): string[] {
  const globs: string[] = [];
  const next = [
    ...new Set(
      names
        .filter((name) => name.length > prefix.length)
        .map((name) => name[prefix.length] as string),
    ),
  ];
  if (prefix && !names.includes(prefix)) globs.push(`!.${prefix}/`);
  globs.push(next.length ? `!.${prefix}[!${next.join("")}]*/` : `!.${prefix}?*/`);
  for (const char of next)
    globs.push(
      ...hiddenDirectoryGlobs(
        prefix + char,
        names.filter((name) => name.startsWith(prefix + char)),
      ),
    );
  return globs;
}
const EXCLUDED = [
  ...hiddenDirectoryGlobs(),
  ...[...SKIPPED_DIRECTORIES].map((name) => `!${name}/`),
].flatMap((glob) => ["--glob", glob]);
// Only the dot-names: a folder with these names is hidden and skipped anyway, so excluding them
// cannot hide anything the JS walk would return. id_rsa / id_ed25519 rely on the JS filter.
const SENSITIVE = [".env", ".env.*", ".npmrc", ".netrc", ".pypirc", ".git-credentials"].flatMap(
  (name) => ["--iglob", `!${name}`],
);
const COMMON = [
  "--no-config",
  "--no-follow",
  "--hidden",
  // The JS walk ignores .gitignore / .ignore files; so must rg, or results would silently shrink.
  "--no-ignore",
  "--null",
  // Files sit at most MAX_DEPTH folders below the root in the JS walk.
  "--max-depth",
  String(MAX_DEPTH + 1),
];

/**
 * A basename-only glob of plain characters is a safe rg prefilter: rg's `*` / `?` match at least
 * what node's matchesGlob does (including leading dots), and the JS filter still runs on every
 * candidate. Anything richer is left to the JS filter alone rather than risk rg dropping a match.
 */
function prefilter(pattern: string | undefined) {
  return pattern && /^[A-Za-z0-9_.*?-]+$/.test(pattern) ? ["--glob", pattern] : [];
}

const COMBINING_DOT_ABOVE = "\u0307";
/** Characters whose case-insensitive match is provably the same in JS and in the bundled rg. */
function foldsAlike(char: string) {
  return (
    char <= "\x7f" ||
    (char !== COMBINING_DOT_ABOVE && char.toLowerCase() === char && char.toUpperCase() === char)
  );
}

/** rg cannot take these as an argument at all; the JS engine keeps its old behaviour. */
export function rgQuerySupported(query: string) {
  // rg rejects line terminators in a literal, and JS never matches them inside one line anyway.
  // A lone surrogate cannot become a UTF-8 argument.
  return !/[\n\0]/.test(query) && Buffer.from(query).toString("utf8") === query;
}

/**
 * Content args when rg's matching is provably a superset of the JS one, else undefined: the
 * caller then lists every file and lets the JS matcher read them all.
 *
 * JS matches `line.toLowerCase().includes(query.toLowerCase())`, rg -i matches by its own Unicode
 * case folding, and the two drift with Unicode versions (Node 26 vs the bundled rg differ on 28
 * pairs such as U+A7CE / U+A7CF). For an ASCII query the only gap left is U+0130 "İ", whose
 * lowercase "i" + U+0307 lets a JS match end inside it; every other code point whose lowercase
 * contains an ASCII letter was checked against the bundled rg.
 *
 * A non-ASCII character with no case mapping in Node (lower = upper = itself, most CJK) is safe
 * too: JS can then only match that exact character, and rg -i always matches its literal. The one
 * exception is U+0307, which JS also produces from "İ" (checked over every code point). So a
 * case-insensitive query goes to rg when each character is ASCII or such a caseless one, plus an
 * "İ" variant when it ends in "i"; anything else is left to the JS matcher.
 */
export function rgContentArgs(input: {
  query: string;
  caseSensitive?: boolean;
  include?: string;
  maxFileBytes: number;
}) {
  let patterns = [input.query];
  if (!input.caseSensitive) {
    if (![...input.query].every(foldsAlike)) return;
    const lowered = input.query.toLowerCase();
    patterns = lowered.endsWith("i") ? [lowered, `${lowered.slice(0, -1)}\u0130`] : [lowered];
  }
  return [
    ...COMMON,
    "--files-with-matches",
    "--fixed-strings",
    input.caseSensitive ? "--case-sensitive" : "--ignore-case",
    "--max-filesize",
    String(input.maxFileBytes),
    ...prefilter(input.include),
    // Later globs win, so the exclusions must follow a positive include glob.
    ...EXCLUDED,
    ...SENSITIVE,
    ...patterns.map((pattern) => `--regexp=${pattern}`),
    "--",
    ".",
  ];
}

/** Every regular file, or with `maxFileBytes` only those rg would also search for text. */
export function rgFileArgs(pattern: string | undefined, maxFileBytes?: number) {
  return [
    ...COMMON,
    "--files",
    ...(maxFileBytes === undefined ? [] : ["--max-filesize", String(maxFileBytes)]),
    ...prefilter(pattern),
    ...EXCLUDED,
    ...SENSITIVE,
    "--",
    ".",
  ];
}
