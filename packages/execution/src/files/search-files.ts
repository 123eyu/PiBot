import { type BigIntStats, constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, matchesGlob } from "node:path";
import { canonicalPath } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";
import { verifyWorkspace } from "../sandbox/workspace.ts";
import { createFilePool, type FilePool } from "./search-pool.ts";
import {
  type RgWalkResult,
  rgContentArgs,
  rgFileArgs,
  rgQuerySupported,
  rgWalk,
  type SearchEngine,
  type WalkGuard,
} from "./search-rg.ts";
import {
  checkedDirectory,
  type DirectoryIdentity,
  type SearchFileContext,
  type SearchTruncation,
  sameIdentity,
  skippableError,
  walkFiles,
} from "./search-walk.ts";

export type { SearchFileContext } from "./search-walk.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 32 * 1024 * 1024;
const MAX_LINE_CHARS = 300;
const MAX_RESULTS = 200;
const TIMEOUT_MS = 20_000;

type Truncation = "results" | "byte_limit";
type WalkResult = RgWalkResult;
type Visit = (
  path: string,
  name: string,
  parent: DirectoryIdentity,
) => SearchTruncation | undefined;
/** Where the candidate files come from: the JS folder walk, or the bundled rg. */
type Walk = (visit: Visit, guard: WalkGuard) => Promise<WalkResult>;
/** `name` marks a hit on the file name itself, not a body line. */
type Match = { file: string; line: number; text: string; name?: true };
type TextSearchOptions = SearchFileContext & {
  caseSensitive?: boolean;
  include?: string;
  /** Also report a file whose own name contains the query, without reading any extra file. */
  matchNames?: boolean;
  /** A read-only reference tree (a vault) counts hard-linked files as skipped, not fatal. */
  skipHardLinks?: boolean;
};
/** Counters the concurrent readers share; matches stay per file until they are merged in order. */
interface TextSearchState {
  query: string;
  readBytes: number;
  skippedLarge: number;
  /** Matches seen so far, only used to stop queueing files the walk has not reached yet. */
  foundTotal: number;
  // Vault searches skip hard-linked notes instead of failing; the result reports them so the
  // caller can still say part of the tree was not read.
  skippedUnreadable: number;
}
type FileMatches = { found: Match[]; truncation?: Truncation };

async function searchRootPath(options: SearchFileContext & { path: string }) {
  if (typeof options.authorizePath !== "function") throw new ExecError("outside_workplace");
  await verifyWorkspace(options.rootIdentities, options.signal);
  const root = await canonicalPath(options.path, options.cwd);
  if (options.expectedPath && root !== options.expectedPath)
    throw new ExecError("outside_workplace");
  return {
    path: root,
    kind: (await lstat(root)).isFile() ? ("file" as const) : ("directory" as const),
  };
}
async function directoryRoot(options: SearchFileContext & { path: string }) {
  const root = await searchRootPath(options);
  // find_files only searches folders; a file argument is a usage error, not boundary evidence.
  if (root.kind === "file") throw new ExecError("file_not_directory");
  return checkedDirectory(root.path, options.signal);
}
function matches(pattern: string | undefined, name: string) {
  if (!pattern) return true;
  return (
    matchesGlob(name, pattern) || (!pattern.includes("/") && matchesGlob(name, `**/${pattern}`))
  );
}
function directoryFilter(pattern: string | undefined) {
  // Only literal leading directories are safe to prune. Complex glob syntax and
  // normalized paths retain the original walk rather than risk hiding a match.
  if (!pattern?.includes("/") || !/^[a-zA-Z0-9_.*? /-]+$/.test(pattern)) return;
  const parts = pattern.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return;
  const prefix: string[] = [];
  for (const part of parts.slice(0, -1)) {
    if (part.includes("*") || part.includes("?")) break;
    prefix.push(part);
  }
  if (!prefix.length) return;
  return (name: string) =>
    name.split("/").every((part, index) => {
      const expected = prefix[index];
      return expected === undefined || matchesGlob(part, expected);
    });
}
function skipSensitive(name: string) {
  const file = name.split("/").at(-1)?.toLowerCase() ?? "";
  return (
    file === ".env" ||
    file.startsWith(".env.") ||
    [".npmrc", ".netrc", ".pypirc", ".git-credentials", "id_rsa", "id_ed25519"].includes(file)
  );
}
async function checkedFile(
  path: string,
  parent: DirectoryIdentity,
  signal: AbortSignal,
): Promise<BigIntStats>;
async function checkedFile(
  path: string,
  parent: DirectoryIdentity,
  signal: AbortSignal,
  skipHardLinks: true,
): Promise<BigIntStats | undefined>;
async function checkedFile(
  path: string,
  parent: DirectoryIdentity,
  signal: AbortSignal,
  skipHardLinks = false,
): Promise<BigIntStats | undefined> {
  await checkedDirectory(parent.path, signal, parent.info);
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new ExecError("outside_workplace");
  if (info.nlink > 1n) {
    // A hard link can point outside the authorized tree; a workplace search must fail rather
    // than read it. A vault is different: backup tools create linked notes in place, and one
    // such note should not make the whole search unusable.
    if (skipHardLinks) return undefined;
    throw new ExecError("outside_workplace");
  }
  signal.throwIfAborted();
  return info;
}
async function finishRoot(root: DirectoryIdentity, options: SearchFileContext) {
  await checkedDirectory(root.path, options.signal, root.info);
  await verifyWorkspace(options.rootIdentities, options.signal);
  if (!(await options.authorizePath(root.path, "directory", options.signal)))
    throw new ExecError("outside_workplace");
}
async function finishFile(path: string, parent: DirectoryIdentity, options: SearchFileContext) {
  // Re-check the file itself and the workspace after reading, same as the folder walk.
  await checkedFile(path, parent, options.signal);
  await verifyWorkspace(options.rootIdentities, options.signal);
  if (!(await options.authorizePath(path, "file", options.signal)))
    throw new ExecError("outside_workplace");
}

// The 20 s budget covers this search alone, so it can be told apart from the caller's
// stop. Only our own deadline degrades into a partial result; a user cancel must still fail.
function deadlineExpired(error: unknown, caller: AbortSignal, deadline: AbortSignal) {
  return !caller.aborted && deadline.aborted && error === deadline.reason;
}

/**
 * The closing identity re-check still runs after our own deadline, on a short budget of its own:
 * it is what proves the root was not swapped during the walk, so a partial result must pass it too.
 */
function closing<T extends { signal: AbortSignal }>(options: T): T {
  return { ...options, signal: AbortSignal.any([options.signal, AbortSignal.timeout(2_000)]) };
}

/** Why a search stopped short: an earlier cap, or the deadline that cut the walk. */
function truncatedBy(walked: WalkResult | undefined, expired: boolean) {
  return walked?.truncated ?? (expired ? ("time_limit" as const) : undefined);
}

// One file's worth of the folder walk, shared by both entry points so a file root
// runs exactly the same per-file checks as a file found while walking.
async function searchFile(
  file: { path: string; name: string; parent: DirectoryIdentity },
  search: {
    options: TextSearchOptions;
    signal: AbortSignal;
    state: TextSearchState;
    found: Match[];
  },
): Promise<Truncation | undefined> {
  const { options, signal, state, found } = search;
  if (
    !matches(options.include, file.name) ||
    skipSensitive(file.name) ||
    !(await options.authorizePath(file.path, "file", signal))
  )
    return;
  // Naming a note is how a person looks for it, so a name hit is reported here — inside the same
  // walk, from the entry's own name, before the body is read — and counts towards the result cap.
  const name = basename(file.name);
  if (
    options.matchNames &&
    (options.caseSensitive ? name : name.toLowerCase()).includes(state.query)
  ) {
    found.push({ file: file.name, line: 1, text: name, name: true });
    if (state.foundTotal + found.length >= MAX_RESULTS) return "results";
  }
  const before = options.skipHardLinks
    ? await checkedFile(file.path, file.parent, signal, true)
    : await checkedFile(file.path, file.parent, signal);
  if (!before) {
    state.skippedUnreadable++;
    return;
  }
  if (before.size > BigInt(MAX_FILE_BYTES)) {
    state.skippedLarge++;
    return;
  }
  if (state.readBytes + Number(before.size) > MAX_READ_BYTES) return "byte_limit";
  const handle = await open(
    file.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let text: string;
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || !sameIdentity(info, before)) throw new ExecError("outside_workplace");
    if (info.nlink > 1n) {
      if (options.skipHardLinks) {
        state.skippedUnreadable++;
        return;
      }
      throw new ExecError("outside_workplace");
    }
    if (info.size > BigInt(MAX_FILE_BYTES)) {
      state.skippedLarge++;
      return;
    }
    // Bounded positional reads also stop a file that grows after stat, unlike readFile().
    const buffer = Buffer.alloc(Math.min(Number(info.size) + 1, MAX_FILE_BYTES + 1));
    let offset = 0;
    while (offset < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        Math.min(32 * 1024, buffer.length - offset),
        offset,
      );
      if (!bytesRead) break;
      offset += bytesRead;
      state.readBytes += bytesRead;
      if (state.readBytes > MAX_READ_BYTES) return "byte_limit";
    }
    if (offset > MAX_FILE_BYTES) {
      state.skippedLarge++;
      return;
    }
    const after = options.skipHardLinks
      ? await checkedFile(file.path, file.parent, signal, true)
      : await checkedFile(file.path, file.parent, signal);
    if (!after) {
      state.skippedUnreadable++;
      return;
    }
    if (
      !sameIdentity(info, after) ||
      info.size !== after.size ||
      info.mtimeNs !== after.mtimeNs ||
      !(await options.authorizePath(file.path, "file", signal))
    )
      throw new ExecError("outside_workplace");
    const bytes = buffer.subarray(0, offset);
    if (bytes.includes(0)) return;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return;
    } // Invalid UTF-8 is binary, not text to return to the model.
  } finally {
    await handle.close();
  }
  let line = 1,
    offset = 0;
  while (offset < text.length) {
    signal.throwIfAborted();
    const end = text.indexOf("\n", offset);
    const value = text.slice(offset, end < 0 ? text.length : end);
    if ((options.caseSensitive ? value : value.toLowerCase()).includes(state.query)) {
      found.push({
        file: file.name,
        line,
        text: value.length > MAX_LINE_CHARS ? `${value.slice(0, MAX_LINE_CHARS)}…` : value,
      });
      if (found.length >= MAX_RESULTS) return "results";
    }
    if (end < 0) break;
    offset = end + 1;
    line++;
  }
  return;
}

/**
 * Walks the folder handing each file to the pool, then merges what the pool produced. Both entry
 * points share it so the cap, the deadline and the closing root re-check behave the same.
 */
async function pooledWalk<Result>(
  pool: FilePool<Result>,
  search: {
    root: DirectoryIdentity;
    options: SearchFileContext;
    signal: AbortSignal;
    deadline: AbortSignal;
  },
  walk: Walk,
  visit: Visit,
) {
  const { root, options, signal, deadline } = search;
  let walked: WalkResult | undefined;
  let expired = false;
  const guard: WalkGuard = { halted: pool.halted };
  try {
    walked = await walk(visit, guard);
  } catch (error) {
    pool.stop();
    if (!deadlineExpired(error, options.signal, deadline)) throw error;
    expired = true;
  }
  const results = await pool.drain();
  if (pool.failure) {
    if (!deadlineExpired(pool.failure.error, options.signal, deadline)) throw pool.failure.error;
    expired = true;
  }
  // Running out of the search's own budget keeps what was found so far; the closing root re-check
  // still runs, because it is what proves the root was not swapped during the walk.
  const closingOptions = expired ? closing(options) : { ...options, signal };
  // The rg walk checked each folder once; the JS walk re-checks each after listing it. Proving them
  // all again here, after the last read, keeps a folder swapped mid-search from being published.
  if (!walked?.failed) await guard.verify?.(closingOptions.signal);
  await finishRoot(root, closingOptions);
  return { walked, results, expired };
}

async function rgExecutable(engine: SearchEngine | undefined, signal: AbortSignal) {
  if (!engine) return;
  try {
    return await engine.executable();
  } catch {
    signal.throwIfAborted();
    // No usable rg on this target: the JS walk is the whole search, not an error for the model.
    engine.fallback("search_rg_unavailable");
    return;
  }
}

/** Code-unit order: the same on every platform, whatever order rg's threads printed in. */
function byName(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function listFiles(
  root: DirectoryIdentity,
  options: SearchFileContext & { pattern: string },
  search: { signal: AbortSignal; deadline: AbortSignal },
  walk: Walk,
) {
  const { signal, deadline } = search;
  const pool = createFilePool<{ name: string; size: number } | undefined>();
  let found = 0;
  let capReached = false;
  let skippedUnreadable = 0;
  const { walked, results, expired } = await pooledWalk(
    pool,
    { root, options, signal, deadline },
    walk,
    (path, name, parent) => {
      // Name filters need no I/O; checking them here keeps rg's full listing out of the queue.
      if (!matches(options.pattern, name) || skipSensitive(name)) return;
      pool.submit(async () => {
        if (!(await options.authorizePath(path, "file", signal))) return;
        try {
          const info = await checkedFile(path, parent, signal);
          if (!(await options.authorizePath(path, "file", signal)))
            throw new ExecError("outside_workplace");
          const file = { name, size: Number(info.size) };
          if (++found >= MAX_RESULTS) {
            capReached = true;
            pool.stop();
          }
          return file;
        } catch (error) {
          signal.throwIfAborted();
          if (!skippableError(error)) throw error;
          skippedUnreadable++;
        }
      });
      // Past the cap the rest of the walk could only add names that are never returned.
      return capReached ? "results" : undefined;
    },
  );
  const files: { name: string; size: number }[] = [];
  for (const file of results) if (file && files.length < MAX_RESULTS) files.push(file);
  return {
    failed: walked?.failed,
    result: {
      path: root.path,
      files,
      truncated: capReached ? ("results" as const) : truncatedBy(walked, expired),
      skippedUnreadable: (walked?.skippedUnreadable ?? 0) + skippedUnreadable,
    },
  };
}

export async function findFiles(
  options: SearchFileContext & { path: string; pattern: string; engine?: SearchEngine },
) {
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, deadline]);
  const checked = { ...options, signal };
  const root = await directoryRoot(checked);
  const search = { signal, deadline };
  const engine = options.engine;
  const executable = await rgExecutable(engine, signal);
  if (engine && executable) {
    const listed = await listFiles(root, options, search, (visit, guard) =>
      rgWalk(
        root,
        checked,
        { executable, files: rgFileArgs(options.pattern), report: engine.cleanup },
        (name) => matches(options.pattern, name) && !skipSensitive(name),
        visit,
        guard,
      ),
    );
    if (!listed.failed) {
      // rg hands files over in its thread order; a complete result is made the same every run.
      listed.result.files.sort((a, b) => byName(a.name, b.name));
      return listed.result;
    }
    options.engine?.fallback("search_rg_failed");
  }
  const listed = await listFiles(root, options, search, (visit) =>
    walkFiles(root, checked, visit, directoryFilter(options.pattern)),
  );
  return listed.result;
}

async function searchDirectory(
  directory: DirectoryIdentity,
  options: TextSearchOptions,
  search: { signal: AbortSignal; deadline: AbortSignal; query: string },
  walk: Walk,
  /** "rg-content": rg already read the candidates' bytes to choose them; "rg-files": it only listed. */
  source: "js" | "rg-content" | "rg-files" = "js",
) {
  const chosenByContent = source === "rg-content";
  const { signal, deadline } = search;
  const state: TextSearchState = {
    query: search.query,
    readBytes: 0,
    skippedLarge: 0,
    foundTotal: 0,
    skippedUnreadable: 0,
  };
  const pool = createFilePool<FileMatches>();
  let skippedUnreadable = 0;
  let halted: SearchTruncation | undefined;
  const { walked, results, expired } = await pooledWalk<FileMatches>(
    pool,
    { root: directory, options, signal, deadline },
    walk,
    (path, name, parent) => {
      // Every check inside searchFile still runs in full; only the reads now overlap, so the walk
      // is not waiting on one file at a time.
      pool.submit(async () => {
        const found: Match[] = [];
        let truncation: Truncation | undefined;
        try {
          // A hard link can carry content from outside the root. The JS walk fails on it before
          // reading; here only matching files arrive, so failing (or counting it) would tell the
          // caller that the outside content contains the query. It is dropped without a trace.
          if (chosenByContent && (await lstat(path, { bigint: true })).nlink > 1n) return { found };
          truncation = await searchFile(
            { path, name, parent },
            { options: { ...options, signal }, signal, state, found },
          );
        } catch (error) {
          signal.throwIfAborted();
          if (!skippableError(error)) throw error;
          skippedUnreadable++;
        }
        // Counted only once a file is done: stopping earlier would drop a file the walk already
        // reached, and the merged prefix must be the same one a sequential walk would return.
        state.foundTotal += found.length;
        if (truncation) {
          halted ??= truncation;
          pool.stop();
        } else if (state.foundTotal >= MAX_RESULTS) pool.stop();
        return { found, truncation };
      });
      // Nothing queued after a cap can be reported, so stop feeding the walk.
      return pool.stopped ? (halted ?? "results") : undefined;
    },
  );

  const merged: Match[] = [];
  let truncated: SearchTruncation | undefined;
  // Walk order, not completion order: the 200-entry cap takes the same prefix a sequential walk did.
  merge: for (const result of results) {
    if (!result) continue;
    for (const match of result.found) {
      if (merged.length >= MAX_RESULTS) break merge;
      merged.push(match);
    }
    if (result.truncation) {
      // Results are in walk order, so this is the same cap a sequential walk would have stopped at.
      truncated = result.truncation;
      break;
    }
  }
  if (merged.length >= MAX_RESULTS) truncated ??= "results";
  truncated ??= truncatedBy(walked, expired);
  return {
    failed: walked?.failed,
    result: {
      path: directory.path,
      matches: merged,
      truncated,
      // rg only knows the large files after a whole listing; an early stop leaves it unknown, and
      // an absent field says so where a 0 would claim that nothing was skipped.
      ...(source === "js"
        ? { skippedLarge: state.skippedLarge }
        : walked?.skippedLarge === undefined
          ? {}
          : { skippedLarge: state.skippedLarge + walked.skippedLarge }),
      skippedUnreadable:
        (walked?.skippedUnreadable ?? 0) + skippedUnreadable + state.skippedUnreadable,
    },
  };
}

export async function searchText(
  options: SearchFileContext & {
    engine?: SearchEngine;
    path: string;
    query: string;
    caseSensitive?: boolean;
    include?: string;
    matchNames?: boolean;
    skipHardLinks?: boolean;
  },
) {
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const signal = AbortSignal.any([options.signal, deadline]);
  const checked = { ...options, signal };
  const root = await searchRootPath(checked);
  // Only plain text: regular expressions can block the event loop beyond any timeout.
  const query = options.caseSensitive ? options.query : options.query.toLowerCase();
  if (!query) throw new ExecError("invalid_input");

  if (root.kind === "file") {
    // A file argument is authorized as that file, never as its folder, and an
    // unreadable explicit file is an error rather than a silent empty result.
    // The per-file filters below would otherwise return "0 matches" for a file
    // that was never searched, which reads to the model as "the text is not there".
    const state: TextSearchState = {
      query,
      readBytes: 0,
      skippedLarge: 0,
      foundTotal: 0,
      skippedUnreadable: 0,
    };
    const name = basename(root.path);
    if (skipSensitive(name)) throw new ExecError("file_sensitive");
    if (!matches(options.include, name)) throw new ExecError("file_filter_mismatch");
    const parent = await checkedDirectory(dirname(root.path), signal);
    const found: Match[] = [];
    let truncated: SearchTruncation | undefined;
    try {
      truncated = await searchFile(
        { path: root.path, name, parent },
        { options: checked, signal, state, found },
      );
      await finishFile(root.path, parent, checked);
    } catch (error) {
      if (!deadlineExpired(error, options.signal, deadline)) throw error;
      await finishFile(root.path, parent, closing(options));
      // An earlier cap already says why the matches stop short; otherwise the clock did.
      truncated ??= "time_limit";
    }
    return {
      path: root.path,
      matches: found,
      truncated,
      skippedLarge: state.skippedLarge,
      // A hard-linked note skipped inside a vault is reported, not dropped silently.
      skippedUnreadable: state.skippedUnreadable,
    };
  }

  const directory = await checkedDirectory(root.path, signal);
  const search = { signal, deadline, query };
  // Name hits and the vault's hard-link rule (knowledge search) need every walked file, not just
  // the ones whose body matches, so those searches stay on the JS walk.
  const engine = options.engine;
  const executable =
    options.matchNames || options.skipHardLinks || !rgQuerySupported(options.query)
      ? undefined
      : await rgExecutable(engine, signal);
  if (engine && executable) {
    // Without content args rg only lists the files and the JS matcher reads every one of them.
    const content = rgContentArgs({
      query: options.query,
      caseSensitive: options.caseSensitive,
      include: options.include,
      maxFileBytes: MAX_FILE_BYTES,
    });
    const searched = await searchDirectory(
      directory,
      options,
      search,
      (visit, guard) =>
        rgWalk(
          directory,
          checked,
          {
            executable,
            files: rgFileArgs(options.include, MAX_FILE_BYTES),
            content,
            all: rgFileArgs(options.include),
            report: engine.cleanup,
          },
          (name) => matches(options.include, name) && !skipSensitive(name),
          visit,
          guard,
        ),
      content ? "rg-content" : "rg-files",
    );
    if (!searched.failed) {
      searched.result.matches.sort((a, b) => byName(a.file, b.file) || a.line - b.line);
      return searched.result;
    }
    options.engine?.fallback("search_rg_failed");
  }
  const searched = await searchDirectory(directory, options, search, (visit) =>
    walkFiles(directory, checked, visit, directoryFilter(options.include)),
  );
  return searched.result;
}
