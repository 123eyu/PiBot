import { appendFile, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * Linux / SRT: bwrap bind-mounts /dev/null over every protected name that is missing in a writable
 * folder, which leaves an empty read-only file there for as long as the sandbox runs (kali
 * acceptance 2026-11-11). SRT removes them after a normal end; a sandbox host that is killed (app
 * quit, crash) leaves them in the user's folder. Owner decision: record what this data directory's
 * sandboxes may create, and at the next start delete only recorded paths that are still that empty
 * read-only placeholder. Names follow SRT's DANGEROUS_FILES plus its protected directories, which
 * appear as files when absent.
 */
export const SANDBOX_PLACEHOLDER_NAMES = [
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
  ".vscode",
  ".idea",
] as const;

const LEDGER_LIMIT = 1024 * 1024;

/**
 * Before a sandboxed command: remember which protected names do not exist yet. `known` holds paths
 * this process already wrote, so repeated commands in the same folder do not grow the ledger.
 */
export async function recordSandboxPlaceholders(
  ledger: string,
  roots: readonly string[],
  known: Set<string>,
) {
  const lines: string[] = [];
  for (const root of roots) {
    if (!isAbsolute(root)) continue;
    for (const name of SANDBOX_PLACEHOLDER_NAMES) {
      const path = join(root, name);
      const exists = await lstat(path).then(
        () => true,
        (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
      );
      if (!exists && !known.has(path)) {
        known.add(path);
        lines.push(JSON.stringify({ path }));
      }
    }
  }
  if (!lines.length) return;
  // Bounded: an oversized ledger is dropped rather than grown; cleanup is best effort by design.
  const size = await lstat(ledger).then(
    (info) => info.size,
    () => 0,
  );
  if (size > LEDGER_LIMIT) await writeFile(ledger, "", { mode: 0o600 });
  await appendFile(ledger, `${lines.join("\n")}\n`, { mode: 0o600 });
}

/**
 * At startup, before this process starts any sandbox: delete recorded placeholders that are still
 * empty, read-only regular files. Anything else (content written, permissions changed, a link, a
 * directory) is left alone; the ledger is consumed either way.
 */
export async function cleanupSandboxPlaceholders(ledger: string) {
  const taken = `${ledger}.cleaning`;
  try {
    await rename(ledger, taken);
  } catch {
    return 0; // No ledger yet.
  }
  let removed = 0;
  const seen = new Set<string>();
  const text = await readFile(taken, "utf8").catch(() => "");
  for (const line of text.split("\n").slice(0, 100_000)) {
    let path: unknown;
    try {
      path = (JSON.parse(line) as { path?: unknown }).path;
    } catch {
      continue;
    }
    if (typeof path !== "string" || !isAbsolute(path) || seen.has(path)) continue;
    seen.add(path);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile() || info.size !== 0 || (info.mode & 0o222) !== 0) continue;
    if (
      !(SANDBOX_PLACEHOLDER_NAMES as readonly string[]).includes(path.split(/[\\/]/).at(-1) ?? "")
    )
      continue;
    await unlink(path).then(
      () => removed++,
      () => undefined,
    );
  }
  await unlink(taken).catch(() => undefined);
  return removed;
}
