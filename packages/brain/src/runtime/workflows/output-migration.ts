import { lstat, mkdir, readdir, rename, rmdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { abortable } from "../../core/abort.ts";
import { LEGACY_OUTPUT_ROOTS, OUTPUT_ROOT_SEGMENTS } from "./workflow-folder.ts";

/**
 * Outputs moved from `<primary>/Pi Bot 产出` (and the
 * older English spellings) to `<primary>/.pibot/out`. The first time a folder is used after the
 * upgrade, each entry is renamed into the new root. Only renames on the same file system: nothing
 * is copied, an existing name in the new root is left where it was, and any symbolic link or
 * non-folder on the way skips the folder entirely.
 */
export interface OutputMigration {
  moved: number;
  skipped: number;
}

const MIGRATION_MS = 5_000;

async function kind(path: string, signal: AbortSignal) {
  const info = await abortable(lstat(path), signal).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return "missing" as const;
  return info.isDirectory() && !info.isSymbolicLink() ? ("folder" as const) : ("other" as const);
}

/** Undefined when there was nothing to move (or the folder is not safe to touch). */
export async function migrateLegacyOutputs(
  primary: string,
  parent: AbortSignal,
): Promise<OutputMigration | undefined> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(MIGRATION_MS)]);
  const legacy: string[] = [];
  for (const name of LEGACY_OUTPUT_ROOTS) {
    const path = join(primary, name);
    if ((await kind(path, signal)) === "folder") legacy.push(path);
  }
  if (!legacy.length) return undefined;
  let root = primary;
  for (const segment of OUTPUT_ROOT_SEGMENTS) {
    root = join(root, segment);
    const state = await kind(root, signal);
    if (state === "other") return undefined;
    if (state === "missing") await abortable(mkdir(root), signal);
  }
  const result: OutputMigration = { moved: 0, skipped: 0 };
  for (const old of legacy) {
    for (const entry of await abortable(readdir(old), signal)) {
      signal.throwIfAborted();
      if ((await kind(join(root, entry), signal)) !== "missing") {
        result.skipped++;
        continue;
      }
      try {
        await rename(join(old, entry), join(root, entry));
        result.moved++;
      } catch {
        // Another device, a locked file or a race: the entry stays in the old folder, unchanged.
        result.skipped++;
      }
    }
    if (!(await abortable(readdir(old), signal)).length)
      await rmdir(old).catch(() => {
        // Recreated meanwhile: it is simply migrated next time.
      });
  }
  return result;
}

/**
 * Where an output path recorded under a legacy root lives after the migration (a routine's
 * previous period):
 * the last legacy root segment replaced by `.pibot/out`. Undefined when the path has none.
 */
export function migratedOutputPath(path: string): string | undefined {
  const parts = path.split(sep);
  const index = parts.findLastIndex((part) =>
    (LEGACY_OUTPUT_ROOTS as readonly string[]).includes(part),
  );
  if (index < 0) return undefined;
  return [...parts.slice(0, index), ...OUTPUT_ROOT_SEGMENTS, ...parts.slice(index + 1)].join(sep);
}
