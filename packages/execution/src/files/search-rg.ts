import { join } from "node:path";
import { listRg, type RgCleanupCode, type RgListingStatus, rgBudget } from "./search-rg-process.ts";
import {
  checkedDirectory,
  type DirectoryIdentity,
  type SearchFileContext,
  type SearchTruncation,
  skippableError,
  skippedDirectory,
} from "./search-walk.ts";

export {
  createSearchEngine,
  rgContentArgs,
  rgFileArgs,
  rgQuerySupported,
  type SearchEngine,
} from "./search-rg-args.ts";

export type RgWalkResult = {
  truncated?: SearchTruncation;
  skippedUnreadable: number;
  /**
   * Files over the size limit that the JS walk would have counted (rg never opens them). Absent
   * when the walk stopped early: the count needs the whole tree, and a guess would read as fact.
   */
  skippedLarge?: number;
  /** rg could not give a complete, trustworthy list: the caller reruns the call on JS. */
  failed?: true;
};
export type WalkGuard = {
  /** The pool stopped (cap reached or a file failed): nothing more it is handed can be reported. */
  halted: AbortSignal;
  /**
   * Set as soon as the walk starts, so it is there even when the deadline cuts the walk short:
   * re-proves every folder identity the walk relied on, after the last file was read.
   */
  verify?(signal: AbortSignal): Promise<void>;
};

const VERIFY_CONCURRENCY = 16;

async function verifyFolders(
  folders: Map<string, Promise<DirectoryIdentity | undefined>>,
  signal: AbortSignal,
) {
  const saved: DirectoryIdentity[] = [];
  for (const entry of await Promise.allSettled(folders.values()))
    if (entry.status === "fulfilled" && entry.value) saved.push(entry.value);
  for (let index = 0; index < saved.length; index += VERIFY_CONCURRENCY)
    await Promise.all(
      saved
        .slice(index, index + VERIFY_CONCURRENCY)
        .map((folder) => checkedDirectory(folder.path, signal, folder.info)),
    );
}

/**
 * Same contract as walkFiles: each regular file is handed to `visit` with its root-relative name
 * and checked parent, after the folder chain was authorized the way the JS walk authorizes it.
 *
 * Candidates are handed over as rg prints them, so a many-hit query stops as soon as the pool has
 * its 200 results: the listings are then torn down (pipes, SIGTERM, SIGKILL, confirmed close).
 * Which 200 that is depends on rg's thread order; a search that was not cut short returns every
 * result, and the caller sorts them.
 */
export async function rgWalk(
  root: DirectoryIdentity,
  options: SearchFileContext,
  plan: {
    executable: string;
    /** Every file rg may consider: all of them (find_files) or those under the size limit. */
    files: string[];
    /** Text search where rg's matching is a proven superset of the JS one: files with a hit. */
    content?: string[];
    /** Text search: every file regardless of size; minus `files`, these are the large ones. */
    all?: string[];
    report(code: RgCleanupCode): void;
  },
  /** The name-only filters the caller applies anyway; checked before storing or folder I/O. */
  keep: (name: string) => boolean,
  visit: (path: string, name: string, parent: DirectoryIdentity) => SearchTruncation | undefined,
  guard: WalkGuard,
): Promise<RgWalkResult> {
  const { signal } = options;
  let skippedUnreadable = 0;
  // Each folder is authorized and identity-checked once per search, as the walk does per opendir.
  const folders = new Map<string, Promise<DirectoryIdentity | undefined>>([
    ["", Promise.resolve(root)],
  ]);
  const folder = (parts: string[]): Promise<DirectoryIdentity | undefined> => {
    const key = parts.join("/");
    let pending = folders.get(key);
    if (!pending) {
      pending = (async () => {
        const parent = await folder(parts.slice(0, -1));
        const name = parts.at(-1) as string;
        if (!parent || skippedDirectory(name)) return;
        const path = join(parent.path, name);
        if (!(await options.authorizePath(path, "directory", signal))) return;
        try {
          // As the JS walk does before queueing a subfolder: the parent must still be the folder
          // that was authorized, or a tree swapped in under the old name would be entered.
          await checkedDirectory(parent.path, signal, parent.info);
          return await checkedDirectory(path, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (!skippableError(error)) throw error;
          skippedUnreadable++;
          return;
        }
      })();
      folders.set(key, pending);
    }
    return pending;
  };
  guard.verify = (current) => verifyFolders(folders, current);
  const accepted = async (name: string) => {
    const parts = name.split("/");
    const parent = await folder(parts.slice(0, -1));
    return parent && { name, parent, path: join(root.path, ...parts) };
  };

  signal.throwIfAborted();
  if (!(await options.authorizePath(root.path, "directory", signal))) return { skippedUnreadable };

  // "Enough": the pool is full or stopped, a visit said stop, or a sibling listing failed.
  const enough = new AbortController();
  const halt = () => enough.abort();
  guard.halted.addEventListener("abort", halt, { once: true });
  if (guard.halted.aborted) halt();
  let truncated: SearchTruncation | undefined;
  // A boundary error from the folder checks is the search's answer, exactly as in the JS walk; it
  // has to leave the listing callback (which swallows errors) and be rethrown here.
  let boundary: { error: unknown } | undefined;
  const offer = async (name: string) => {
    if (enough.signal.aborted) return;
    try {
      const file = await accepted(name);
      if (!file || enough.signal.aborted) return;
      truncated = visit(file.path, file.name, file.parent);
      if (truncated) halt();
    } catch (error) {
      boundary ??= { error };
      halt();
    }
  };
  const budget = rgBudget();
  const list = (args: string[], onPath: (name: string) => void | Promise<void>) =>
    listRg(
      { executable: plan.executable, args, cwd: root.path },
      budget,
      signal,
      enough.signal,
      onPath,
      plan.report,
    ).then((status) => {
      if (status === "failed") halt();
      return status;
    });
  // Only names that pass `keep` are looked at. The size-limited set is only kept when the large
  // files have to be told apart; `all` is never stored, it waits for that set (backpressure) and
  // keeps just the names missing from it.
  const files = new Set<string>();
  const large: string[] = [];
  let filesListed: () => void = () => {};
  const filesDone = new Promise<void>((resolve) => {
    filesListed = resolve;
  });
  let waited = false;
  let statuses: RgListingStatus[];
  try {
    const settled = await Promise.allSettled([
      list(plan.files, async (name) => {
        if (!keep(name)) return;
        if (plan.all) files.add(name);
        if (!plan.content) await offer(name);
      }).finally(() => filesListed()),
      ...(plan.content
        ? [
            list(plan.content, async (name) => {
              if (keep(name)) await offer(name);
            }),
          ]
        : []),
      ...(plan.all
        ? [
            list(plan.all, async (name) => {
              if (!waited) {
                waited = true;
                await filesDone;
              }
              if (keep(name) && !files.has(name)) large.push(name);
            }),
          ]
        : []),
    ]);
    statuses = settled.map((entry) => {
      if (entry.status === "rejected") throw entry.reason;
      return entry.value;
    });
  } finally {
    guard.halted.removeEventListener("abort", halt);
  }
  if (boundary) throw boundary.error;
  if (statuses.includes("failed")) return { skippedUnreadable, failed: true };
  if (statuses.includes("stopped")) return { truncated, skippedUnreadable };

  let skippedLarge: number | undefined;
  if (plan.all) {
    // Same order as the JS check: name filters, folder and file authorization, then the size.
    skippedLarge = 0;
    for (const name of large) {
      const file = await accepted(name);
      if (file && (await options.authorizePath(file.path, "file", signal))) skippedLarge++;
    }
  }
  return { truncated, skippedUnreadable, skippedLarge };
}
