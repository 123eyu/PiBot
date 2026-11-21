import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import { within } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";

async function present(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Linux only: bubblewrap can bind a write path only when it exists, and SRT drops an absent one,
 * leaving it read-only (`git worktree add` then cannot create its branch directory). The fixed
 * recipe names the directories its command will create; they are made here, one component at a
 * time beneath a held root, so the sandbox gets the same exact capability Seatbelt grants for an
 * absent literal path. Returns what was made, deepest last.
 */
export async function createRecipeDirectories(paths: string[], roots: string[]) {
  const created: string[] = [];
  try {
    for (const path of paths) {
      const missing: string[] = [];
      let at = path;
      while (!(await present(at))) {
        missing.unshift(at);
        const parent = dirname(at);
        if (parent === at) throw new ExecError("outside_workplace");
        at = parent;
      }
      if (!missing.length) continue;
      // The existing ancestor must be a real directory inside a held root, not a link out of it.
      if (
        !roots.some((root) => within(root, at)) ||
        !(await lstat(at)).isDirectory() ||
        (await realpath(at)) !== at
      )
        throw new ExecError("outside_workplace", "write_path_alias");
      for (const directory of missing) {
        // Not recursive: a name that appeared meanwhile (EEXIST) is not ours to trust.
        await mkdir(directory);
        created.push(directory);
        if (!(await lstat(directory)).isDirectory() || (await realpath(directory)) !== directory)
          throw new ExecError("outside_workplace", "write_path_alias");
      }
    }
    return created;
  } catch (error) {
    await removeRecipeDirectories(created);
    throw error;
  }
}

/** Undoes createRecipeDirectories after a failed recipe; directories the command filled stay. */
export async function removeRecipeDirectories(created: string[]) {
  for (const directory of [...created].reverse()) {
    try {
      await rmdir(directory);
    } catch (error) {
      // Filled by the command (its own state now) or already gone: either way nothing of ours
      // is left to remove, and the recipe's own error is what the caller reports.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw error;
    }
  }
}
