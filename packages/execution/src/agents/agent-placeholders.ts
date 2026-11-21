// Linux / SRT: an external agent's sandbox denies hook, plugin and Git names in its folders
// (external-agent-denies.ts, SRT's own dangerous names); bubblewrap leaves an empty placeholder
// for each missing one, and Pi Bot creates the agent folders those names sit in (.claude, .codex,
// .cursor, .opencode) before launch. Owner rule (2026-11-11, same as for Pi Bot's own commands):
// none of it may stay in the user's folder. What was absent before launch is recorded (also in a
// ledger in Pi Bot's data, for a crash); after the agent stops, and at the next start, each
// recorded path that is still an empty file or an empty folder is removed. Anything with content
// is the agent's or the user's and is left alone.
import { appendFile, lstat, readdir, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { SANDBOX_PLACEHOLDER_NAMES } from "../sandbox/placeholder-ledger.ts";
import { PROJECT_HOOK_PATHS } from "./external-agent-denies.ts";

/** Names in each topic folder the agent sandbox may leave behind, deepest last. */
const CANDIDATES = [
  ...SANDBOX_PLACEHOLDER_NAMES,
  ".git",
  ".git/hooks",
  ".git/config",
  ...new Set(
    PROJECT_HOOK_PATHS.filter((path) => path.includes("/")).map((path) => path.split("/")[0]),
  ),
  ...PROJECT_HOOK_PATHS,
] as readonly string[];

/** Relative paths (POSIX separators) the changes panel treats as sandbox noise when empty. */
export const AGENT_PLACEHOLDER_PATHS: readonly string[] = [...new Set(CANDIDATES)];

const LEDGER_LIMIT = 1024 * 1024;

const absent = (path: string) =>
  lstat(path).then(
    () => false,
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );

/** Before launch: the candidate paths that do not exist yet, recorded in the ledger as well. */
export async function recordAgentPlaceholders(roots: readonly string[], ledger?: string) {
  const missing: string[] = [];
  for (const root of roots) {
    if (!isAbsolute(root)) continue;
    for (const name of AGENT_PLACEHOLDER_PATHS) {
      const path = join(root, ...name.split("/"));
      if (await absent(path)) missing.push(path);
    }
  }
  if (ledger && missing.length) {
    // Bounded and best effort: a lost record only means a crashed run's placeholders stay.
    const size = await lstat(ledger).then(
      (info) => info.size,
      () => 0,
    );
    if (size < LEDGER_LIMIT)
      await appendFile(ledger, `${missing.map((path) => JSON.stringify({ path })).join("\n")}\n`, {
        mode: 0o600,
      }).catch(() => undefined);
  }
  return missing;
}

/** Removes the recorded paths that are still empty placeholders, deepest first. */
export async function removeAgentPlaceholders(paths: readonly string[]) {
  let removed = 0;
  const ordered = [...new Set(paths)].sort(
    (a, b) => b.split(sep).length - a.split(sep).length || b.localeCompare(a),
  );
  for (const path of ordered) {
    const info = await lstat(path).catch(() => undefined);
    if (!info) continue;
    if (info.isFile() && info.size === 0) {
      await unlink(path).then(
        () => removed++,
        () => undefined,
      );
    } else if (info.isDirectory() && !info.isSymbolicLink()) {
      const entries = await readdir(path).catch(() => ["?"]);
      if (!entries.length)
        await rmdir(path).then(
          () => removed++,
          () => undefined,
        );
    }
  }
  return removed;
}

/** At startup: the ledger's paths from runs that never cleaned up (app quit, crash). */
export async function cleanupAgentPlaceholders(ledger: string) {
  const taken = `${ledger}.cleaning`;
  try {
    await rename(ledger, taken);
  } catch {
    return 0; // No ledger yet.
  }
  const text = await readFile(taken, "utf8").catch(() => "");
  const paths: string[] = [];
  for (const line of text.split("\n").slice(0, 100_000)) {
    try {
      const path = (JSON.parse(line) as { path?: unknown }).path;
      if (typeof path === "string" && isAbsolute(path)) paths.push(path);
    } catch {
      // A torn last line from a crash: skip it.
    }
  }
  // Only names the agent sandbox can create; a damaged ledger cannot point anywhere else.
  const allowed = paths.filter((path) =>
    AGENT_PLACEHOLDER_PATHS.some((name) => path.endsWith(`${sep}${name.split("/").join(sep)}`)),
  );
  const removed = await removeAgentPlaceholders(allowed);
  await unlink(taken).catch(() => undefined);
  return removed;
}
