import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { PreparedTool } from "../../../core/local-types.ts";

/**
 * `idempotent`: whether the target already holds exactly what this call would write. Only
 * a full-content `write_file` can be checked; other idempotent tools (generated Office files are
 * not byte-stable) return undefined. Compares sizes first, so a changed file usually costs one stat.
 */
export async function targetMatches(
  prepared: PreparedTool,
  signal: AbortSignal,
): Promise<boolean | undefined> {
  if (prepared.call.tool !== "write_file") return undefined;
  const path = prepared.result.path?.path;
  const content = prepared.call.input.content;
  if (!path || typeof content !== "string") return false;
  const expected = Buffer.from(content, "utf8");
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size !== expected.length) return false;
    // O_NOFOLLOW where the platform has it: a link swapped in after lstat is not followed.
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      signal.throwIfAborted();
      const actual = await file.readFile({ signal });
      return actual.equals(expected);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (signal.aborted) throw error;
    // A missing, unreadable or replaced target is simply not the intended content; the call then
    // takes the ordinary path, whose own checks report any real problem.
    const code = String((error as { code?: unknown }).code);
    if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "EISDIR"].includes(code)) return false;
    throw error;
  }
}
