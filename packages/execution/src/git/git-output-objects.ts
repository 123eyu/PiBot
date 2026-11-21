import type { Dir } from "node:fs";
import { opendir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import type { GitObjectObservation } from "./git-config-object-view.ts";
import { GitOutputSourceError } from "./git-output-error.ts";
import { type OutputScanBudget, outputScanBatch, outputScanBudget } from "./git-output-scan.ts";
import { gitResourceIdentity } from "./git-resource-identity.ts";

type Observation = GitObjectObservation & {
  identity: NonNullable<GitObjectObservation["identity"]>;
};
type Scan = {
  budget: OutputScanBudget;
  device: string;
  count: number;
  width: number;
};
function count(scan: Scan) {
  scan.budget.check();
  // Preserve the original loop check + observe check accounting, not one unit per object.
  if (++scan.count > 100000) throw new GitOutputSourceError("object_limit");
}
async function observe(path: string, type: "file" | "directory", scan: Scan): Promise<Observation> {
  count(scan);
  const identity = await scan.budget.read(() => gitResourceIdentity(path));
  if (
    !identity ||
    identity.type !== type ||
    identity.device !== scan.device ||
    (await scan.budget.read(() => realpath(path))) !== path ||
    (type === "file" && identity.links !== "1")
  )
    throw new GitOutputSourceError("object_layout");
  return { path, identity };
}
async function verifyDirectory(directory: Observation, scan: Scan) {
  const current = await scan.budget.read(() => gitResourceIdentity(directory.path));
  if (
    current?.type !== "directory" ||
    current.device !== directory.identity.device ||
    current.inode !== directory.identity.inode ||
    (await scan.budget.read(() => realpath(directory.path))) !== directory.path
  )
    throw new GitOutputSourceError("object_layout");
}
async function readDirectory<T>(
  directory: Observation,
  scan: Scan,
  inspect: (name: string) => Promise<T>,
  accept: (result: T) => void,
) {
  let iterator: Dir | undefined;
  try {
    await verifyDirectory(directory, scan);
    scan.budget.check();
    // Capture ownership before the post-open check, including when open exceeds the deadline.
    iterator = await opendir(directory.path);
    scan.budget.check();
    await verifyDirectory(directory, scan);
    const opened = iterator;
    let ended = false;
    while (!ended) {
      const names: string[] = [];
      while (names.length < 8) {
        const entry = await scan.budget.read(() => opened.read());
        if (!entry) {
          ended = true;
          break;
        }
        names.push(entry.name);
      }
      for (const result of await outputScanBatch(names, scan.budget, inspect)) accept(result);
    }
  } catch (error) {
    scan.budget.remember(error);
  } finally {
    scan.budget.observe();
    if (iterator) {
      try {
        await iterator.close();
      } catch (error) {
        scan.budget.remember(error);
      }
    }
    scan.budget.observe();
  }
  scan.budget.check();
}
function allowedFile(directory: string, name: string, width: number) {
  return directory === "info"
    ? /^(?:packs|commit-graph)$/.test(name)
    : directory === "pack"
      ? /^(?:pack-[a-f0-9]{40}(?:[a-f0-9]{24})?\.(?:pack|idx|rev|bitmap|mtimes|keep))$/.test(name)
      : new RegExp(`^[a-f0-9]{${width - 2}}$`).test(name);
}

/** Complete namespace coverage; only eight metadata tasks and one directory handle at a time. */
export async function inspectOutputObjects(git: string, width: number, signal: AbortSignal) {
  const budget = outputScanBudget(signal);
  const repository = await budget.read(() => gitResourceIdentity(git));
  if (repository?.type !== "directory") throw new GitOutputSourceError("object_layout");
  const scan: Scan = { budget, device: repository.device, count: 0, width };
  const sources: GitObjectObservation[] = [];
  for (const name of ["commondir", "gitdir", "shallow", "info/grafts", "refs/replace"]) {
    const path = join(git, name);
    const identity = await budget.read(() => gitResourceIdentity(path));
    if (identity) throw new GitOutputSourceError("object_layout");
    sources.push({ path, identity });
  }
  const objects = await observe(join(git, "objects"), "directory", scan);
  sources.push(objects);
  // The fixed namespace and global count bound this queue; close the root before a child.
  const directories: Observation[] = [];
  await readDirectory(
    objects,
    scan,
    async (name) => {
      count(scan);
      if (!/^(?:[a-f0-9]{2}|info|pack)$/.test(name))
        throw new GitOutputSourceError("object_layout");
      return observe(join(objects.path, name), "directory", scan);
    },
    (directory) => directories.push(directory),
  );
  for (const directory of directories) {
    sources.push(directory);
    let entries = 0;
    const name = basename(directory.path);
    await readDirectory(
      directory,
      scan,
      async (child) => {
        count(scan);
        if ((name === "info" || name === "pack") && ++entries > 256)
          throw new GitOutputSourceError("object_limit");
        if (!allowedFile(name, child, scan.width)) throw new GitOutputSourceError("object_layout");
        return observe(join(directory.path, child), "file", scan);
      },
      (source) => sources.push(source),
    );
  }
  budget.check();
  return { sources };
}
