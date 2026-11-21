import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fail, projectRoot } from "./process.ts";

// Restart backups are produced outside the repo (an old app bundle is moved aside before a
// packaged run); nothing prunes them, and each one is ~1 GB. Keeping a few for rollback is
// enough — older copies are reproducible with pnpm app:package.
const backupDirectory = join(projectRoot, "apps/desktop/.cache/restart-backups");

interface Entry {
  name: string;
  path: string;
  modified: number;
  bytes: number;
}

async function measure(path: string): Promise<number> {
  // lstat: a symlink here must not be followed (a cycle or a link to the app bundle would run
  // forever), and its target is not ours to delete or to count as a kept copy.
  const info = await lstat(path);
  if (info.isSymbolicLink()) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const child of await readdir(path)) total += await measure(join(path, child));
  return total;
}

async function collect(): Promise<Entry[]> {
  let names: string[];
  try {
    names = await readdir(backupDirectory);
  } catch {
    return [];
  }
  const entries: Entry[] = [];
  for (const name of names) {
    const path = join(backupDirectory, name);
    const info = await lstat(path);
    // Only real directories are backups; a link would be counted and later "removed" as one.
    if (info.isSymbolicLink() || !info.isDirectory()) continue;
    entries.push({ name, path, modified: info.mtimeMs, bytes: await measure(path) });
  }
  return entries.sort((a, b) => b.modified - a.modified);
}

function gib(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

try {
  const { values } = parseArgs({
    options: {
      keep: { type: "string", default: "2" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const keep = Number(values.keep);
  if (!Number.isInteger(keep) || keep < 0) throw new Error(`Invalid --keep: ${values.keep}`);
  const entries = await collect();
  if (!entries.length) {
    console.log(`No restart backups under ${backupDirectory}.`);
  } else {
    const stale = entries.slice(keep);
    const freed = stale.reduce((sum, entry) => sum + entry.bytes, 0);
    for (const entry of stale) {
      console.log(
        `${values["dry-run"] ? "would remove" : "removing"} ${entry.name} ${gib(entry.bytes)}`,
      );
      if (!values["dry-run"]) await rm(entry.path, { recursive: true, force: true });
    }
    console.log(
      `Kept ${Math.min(keep, entries.length)} of ${entries.length} backups; ` +
        `${values["dry-run"] ? "would free" : "freed"} ${gib(freed)}.`,
    );
  }
} catch (error) {
  fail(error);
}
