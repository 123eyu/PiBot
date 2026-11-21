import type { Dir } from "node:fs";
import { join } from "node:path";
import { fileIdentity } from "../core/file-identity.ts";
import { type AliasFileSystem, ExecError } from "../core/types.ts";
import { aliasDenyMatcher } from "./alias-deny.ts";

const ENTRY_LIMIT = 100000;
const BATCH_SIZE = 8;
type Directory = { path: string; device: string; inode: string };
type Entry = { alias?: string; directory?: Directory };

/** A failed batch drains before throwing; cleanup observes deadlines without skipping close. */
function scanBudget(signal: AbortSignal) {
  const until = performance.now() + 15000;
  let failed = false;
  let failure: unknown;
  const remember = (error: unknown) => {
    if (!failed) failure = error;
    failed = true;
  };
  const observe = () => {
    if (signal.aborted) remember(signal.reason);
    if (performance.now() > until) remember(new ExecError("isolation_scan_limit"));
  };
  const check = () => {
    observe();
    if (failed) throw failure;
  };
  return {
    remember,
    observe,
    check,
    async read<T>(operation: () => Promise<T>) {
      check();
      let value: T;
      try {
        value = await operation();
      } catch (error) {
        remember(error);
        check();
        throw error;
      }
      check();
      return value;
    },
  };
}

type Scan = {
  filesystem: AliasFileSystem;
  budget: ReturnType<typeof scanBudget>;
  deniedPath(path: string): boolean;
  entries: number;
};
async function identifyDirectory(path: string, { filesystem, budget }: Scan): Promise<Directory> {
  const info = await budget.read(() => filesystem.lstat(path, { bigint: true }));
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await budget.read(() => filesystem.realpath(path))) !== path
  )
    throw new ExecError("isolation_unavailable");
  return { path, ...fileIdentity(info) };
}
async function verifyDirectory(directory: Directory, scan: Scan) {
  const current = await identifyDirectory(directory.path, scan);
  if (current.device !== directory.device || current.inode !== directory.inode)
    throw new ExecError("isolation_unavailable");
}
async function inspectEntry(full: string, { filesystem, budget }: Scan): Promise<Entry> {
  const info = await budget.read(() => filesystem.lstat(full, { bigint: true }));
  if (info.isSymbolicLink()) return {};
  if (info.isFile() && info.nlink > 1n) return { alias: full };
  if (info.isDirectory()) {
    if ((await budget.read(() => filesystem.realpath(full))) !== full)
      throw new ExecError("isolation_unavailable");
    return { directory: { path: full, ...fileIdentity(info) } };
  }
  return {};
}
async function readBatch(iterator: Dir, directory: string, scan: Scan) {
  const batch: string[] = [];
  let ended = false;
  while (batch.length < BATCH_SIZE) {
    const entry = await scan.budget.read(() => iterator.read());
    if (!entry) {
      ended = true;
      break;
    }
    if (++scan.entries > ENTRY_LIMIT) throw new ExecError("isolation_scan_limit");
    const full = join(directory, entry.name);
    if (!scan.deniedPath(full)) batch.push(full);
  }
  return { batch, ended };
}
async function inspectBatch(batch: string[], scan: Scan) {
  const results = await Promise.allSettled(
    batch.map(async (full) => {
      try {
        return await inspectEntry(full, scan);
      } catch (error) {
        scan.budget.remember(error);
        throw error;
      }
    }),
  );
  scan.budget.check();
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}
async function closeDirectory(iterator: Dir | undefined, { budget }: Scan) {
  if (!iterator) return;
  budget.observe();
  try {
    await iterator.close();
  } catch (error) {
    budget.remember(error);
  }
  budget.observe();
}
async function scanDirectory(directory: Directory, scan: Scan, accept: (entry: Entry) => void) {
  const { filesystem, budget } = scan;
  let iterator: Dir | undefined;
  try {
    await verifyDirectory(directory, scan);
    budget.check();
    // Own the handle before checking the post-open budget so even a late open is closed.
    iterator = await filesystem.opendir(directory.path);
    budget.check();
    await verifyDirectory(directory, scan);
    for (;;) {
      const { batch, ended } = await readBatch(iterator, directory.path, scan);
      for (const entry of await inspectBatch(batch, scan)) accept(entry);
      if (ended) break;
    }
  } catch (error) {
    budget.remember(error);
  } finally {
    await closeDirectory(iterator, scan);
  }
  budget.check();
}

/** Complete metadata coverage, with one directory handle and at most eight in-flight entries. */
export async function scanCommandAliases(
  roots: readonly string[],
  denied: readonly string[],
  signal: AbortSignal,
  filesystem: AliasFileSystem,
) {
  const scan: Scan = {
    budget: scanBudget(signal),
    filesystem,
    deniedPath: aliasDenyMatcher(denied),
    entries: 0,
  };
  const aliases: string[] = [];
  const visited = new Set<string>();
  for (const root of roots) {
    const canonical = await scan.budget.read(() => filesystem.realpath(root));
    if (visited.has(canonical)) continue;
    const queue: (Directory | undefined)[] = [await identifyDirectory(canonical, scan)];
    visited.add(canonical);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const directory = queue[cursor];
      queue[cursor] = undefined;
      if (!directory) throw new ExecError("isolation_unavailable");
      await scanDirectory(directory, scan, (entry) => {
        if (entry.alias) aliases.push(entry.alias);
        const child = entry.directory;
        if (child && !visited.has(child.path)) {
          visited.add(child.path);
          queue.push(child);
        }
      });
    }
  }
  scan.budget.check();
  return aliases;
}
