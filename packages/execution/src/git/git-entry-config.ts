import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configurationGitProgram, runConfigurationGit } from "./git-config-process.ts";
import { type BoundPath, EntryScanIncomplete, readBoundFile } from "./git-entry-files.ts";

export interface ConfigEntry {
  /** Git's canonical key: section and variable lowercased, subsection kept. */
  key: string;
  /** Kept in memory for classification only; never returned in facts, logs or audit. */
  value: string | undefined;
}
export interface ConfigSource {
  bound: BoundPath;
  entries: ConfigEntry[];
}
export interface ConfigReader {
  platform: NodeJS.Platform;
  env: Readonly<NodeJS.ProcessEnv>;
  privateTempRoot: string;
  signal: AbortSignal;
}

/**
 * Variable names that can name a program or change where Git looks for one. A config file whose
 * text matches none of them (the usual core/remote/branch/user file) needs no parsing at all;
 * Git keys cannot span lines, so a line-start or after-`]` match is a sound pre-filter.
 */
const INTERESTING =
  /(?:^|\])[ \t]*(?:hookspath|fsmonitor|editor|askpass|gitproxy|alternaterefscommand|sshcommand|helper|clean|smudge|process|external|command|textconv|driver|program|defaultkeycommand|update|cmd|templatedir|path|worktree|worktreeconfig|uploadpack|receivepack|vcs|insteadof|pushinsteadof|allow|recurse)[ \t]*(?:=|$|[;#])/im;
const SECTIONS = /\[[ \t]*(?:alias|include|includeif)\b/i;

/**
 * Parses one config file with the fixed Git binary on a private copy, without includes and with
 * no ambient configuration, so parsing can never run anything the file names.
 */
export async function readConfigSource(
  path: string,
  reader: ConfigReader,
  always = false,
): Promise<ConfigSource> {
  const { bound, bytes } = readBoundFile(path);
  if (bound.kind !== "file" || !bytes) return { bound, entries: [] };
  const text = bytes.toString("utf8");
  if (!always && !INTERESTING.test(text) && !SECTIONS.test(text) && !text.includes("::"))
    return { bound, entries: [] };
  const program = await configurationGitProgram("git", reader);
  if (!program) throw new EntryScanIncomplete("git_unavailable");
  const directory = await mkdtemp(join(reader.privateTempRoot, "git-entry-"));
  try {
    const copy = join(directory, "config");
    await writeFile(copy, bytes, { mode: 0o600, flag: "wx" });
    const signal = AbortSignal.any([reader.signal, AbortSignal.timeout(10_000)]);
    let output: Buffer;
    try {
      output = await runConfigurationGit(
        program,
        ["--file", copy, "--list", "-z"],
        directory,
        reader,
        signal,
      );
    } catch (error) {
      reader.signal.throwIfAborted();
      // Unparseable or slow: whether it names a program is unknown, so refuse rather than guess.
      throw new EntryScanIncomplete(error instanceof Error ? error.message : "parse_failed");
    }
    const entries = output
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const newline = record.indexOf("\n");
        return newline < 0
          ? { key: record, value: undefined }
          : { key: record.slice(0, newline), value: record.slice(newline + 1) };
      });
    return { bound, entries };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Last value wins, as in Git. */
export function lastValue(sources: readonly ConfigSource[], key: string) {
  let value: string | undefined;
  let found = false;
  for (const source of sources)
    for (const entry of source.entries)
      if (entry.key.toLowerCase() === key) {
        value = entry.value;
        found = true;
      }
  return found ? (value ?? "") : undefined;
}

/** Shown on the card: driver names stay, URL-like subsections (may hold user names) do not. */
export function displayKey(key: string) {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first < 0 || first === last) return key.toLowerCase();
  const section = key.slice(0, first).toLowerCase();
  const subsection = key.slice(first + 1, last);
  const safe =
    !["credential", "url", "http", "remote", "includeif"].includes(section) &&
    /^[A-Za-z0-9._-]{1,64}$/.test(subsection);
  return `${section}.${safe ? subsection : "<…>"}.${key.slice(last + 1).toLowerCase()}`;
}
