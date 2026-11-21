import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { sensitiveReadBoundary } from "@pibot/execution";
import { resolveDataDir } from "@pibot/storage";

/**
 * Resolves the deepest part of the path that exists, then re-attaches the rest. A target that does
 * not exist yet can still sit below a symlinked parent (`--data /tmp/link/new`), which would read as
 * an unrelated path if only the plain string were compared.
 */
function normalize(path: string) {
  let existing = resolve(path);
  const missing: string[] = [];
  let full: string;
  for (;;) {
    try {
      full = join(realpathSync(existing), ...missing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing) {
        full = resolve(path);
        break;
      }
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
  // macOS and Windows compare case-insensitively; the kernel would open the same directory.
  return process.platform === "linux" ? full : full.toLowerCase();
}

/**
 * The desktop app owns its data directory. Pointed at it, this process would decrypt nothing (the
 * CLI has no safeStorage), rewrite the app's default model on the main Bot, run routines from a
 * second scheduler on the same SQLite, and deny approval cards belonging to the app's other runs.
 * Returns the reason to refuse, or undefined when the directory is the CLI's own.
 *
 * Known limit: only the directories the desktop app would pick in this environment are known here.
 * An app started with its own PIBOT_DATA_DIR elsewhere is not recognised.
 */
export function appDataDirReason(dataDir: string): string | undefined {
  const candidates = [false, true].map((dev) =>
    resolveDataDir({ platform: process.platform, env: process.env, homedir: homedir(), dev }),
  );
  const target = normalize(dataDir);
  const hit = candidates.find(
    (dir) => target.startsWith(`${normalize(dir)}${sep}`) || target === normalize(dir),
  );
  return hit
    ? `--data must not be the desktop app's data directory (${hit}). / --data 指向桌面应用的数据目录，请换一个本工具独占的目录`
    : undefined;
}

/**
 * Bot homes live under the data directory and must stay readable inside the command sandbox, which
 * never re-opens a protected region (credential stores, other agents' config such as `~/.claude`).
 * Without this check startup succeeds and every new topic later fails as an opaque internal error.
 */
export async function protectedDataDirReason(dataDir: string): Promise<string | undefined> {
  const boundary = await sensitiveReadBoundary(process.platform, [homedir()], process.env);
  const target = normalize(dataDir);
  const hit = boundary.denyRead.find((root) => {
    const base = normalize(root);
    return target === base || target.startsWith(`${base}${sep}`);
  });
  return hit
    ? `--data must not be inside a protected directory (${hit}); Bot files there cannot be read by the command sandbox. / --data 位于受保护目录内，沙箱无法读取其中的 Bot 文件，请换一个普通目录`
    : undefined;
}

/** Every headless entry refuses the same directories before it starts a brain on them. */
export async function dataDirRefusal(dataDir: string): Promise<string | undefined> {
  return appDataDirReason(dataDir) ?? (await protectedDataDirReason(dataDir));
}
