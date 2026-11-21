import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { runtimeDirectory } from "./process.ts";

export const dataRoot = join(runtimeDirectory, "data");
export async function testDataDirectory(input?: string, create = false): Promise<string> {
  const value = resolve(input ?? join(dataRoot, "default"));
  // Keep destructive fresh and DB inspection away from real application/user data.
  const rel = relative(dataRoot, value);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new Error(`Test data must be a child of ${dataRoot}`);
  let cursor = dataRoot;
  for (const segment of rel.split(/[\\/]/)) {
    cursor = join(cursor, segment);
    try {
      if ((await lstat(cursor)).isSymbolicLink())
        throw new Error(`Symlink data path forbidden: ${cursor}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    if (
      (await lstat(runtimeDirectory)).isSymbolicLink() ||
      (await lstat(dataRoot)).isSymbolicLink()
    )
      throw new Error("Symlink runtime/data forbidden.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (create) {
    await mkdir(value, { recursive: true });
    await realpath(value);
  }
  return value;
}
