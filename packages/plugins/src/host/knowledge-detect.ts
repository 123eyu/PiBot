import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { KnowledgeDetection, KnowledgeVault } from "@pibot/plugins-contract/full";

/** Obsidian's own list; it holds vault entries, never note content, and stays small. */
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_VAULTS = 50;
/** The contract's name limit (counted in UTF-16 units), so a long folder name cannot fail us. */
const MAX_NAME_UNITS = 200;
/** How many candidate paths may be probed at all, so a crafted list cannot fan out. */
const MAX_CANDIDATES = 200;
/** A vault on a disconnected share answers "not here" instead of stalling the tab. */
const PROBE_TIMEOUT_MS = 2_000;
/** The whole scan stays inside the brain's 25 s RPC budget, however many probes hang. */
const DETECT_TIMEOUT_MS = 15_000;
/** A few probes at a time: enough to hide latency, few enough to spare a network share. */
const PROBE_CONCURRENCY = 8;

/**
 * Look at what this computer already keeps, without reading any of it. Obsidian publishes
 * its vault list (`obsidian.json`); Notion only counts as installed because its pages live on their
 * servers. Runs in the desktop main process: paths differ per platform, and the brain must not
 * guess them. Every lookup is best-effort — "not found" is the answer, never an error.
 */
export async function detectKnowledge(options: {
  platform: NodeJS.Platform;
  home: string;
  env: (name: string) => string | undefined;
}): Promise<KnowledgeDetection> {
  const { platform, home, env } = options;
  // One deadline for the whole scan: home directories can live on a network share, where every
  // stat would otherwise wait for the same stalled server.
  const deadline = AbortSignal.timeout(DETECT_TIMEOUT_MS);
  const [vaults, obsidianInstalled, notionInstalled] = await Promise.all([
    listedVaults(obsidianConfigs(platform, home, env), deadline),
    // Linux has no single install location, so the vault list is the only signal there.
    platform === "linux"
      ? Promise.resolve(false)
      : anyExists(appPaths(platform, "obsidian", home, env), deadline),
    anyExists(appPaths(platform, "notion", home, env), deadline),
  ]);
  return {
    obsidian: { installed: obsidianInstalled, vaults },
    notion: { installed: notionInstalled },
  };
}

export function obsidianConfigs(
  platform: NodeJS.Platform,
  home: string,
  env: (name: string) => string | undefined,
): string[] {
  if (platform === "darwin")
    return [join(home, "Library", "Application Support", "obsidian", "obsidian.json")];
  if (platform === "win32") {
    const roaming = env("APPDATA") ?? join(home, "AppData", "Roaming");
    return [join(roaming, "obsidian", "obsidian.json")];
  }
  if (platform === "linux")
    // Flatpak and Snap keep their own XDG config, so the vault list is invisible at ~/.config.
    return [
      join(home, ".config", "obsidian", "obsidian.json"),
      join(home, ".var", "app", "md.obsidian.Obsidian", "config", "obsidian", "obsidian.json"),
      join(home, "snap", "obsidian", "current", ".config", "obsidian", "obsidian.json"),
    ];
  return [];
}

function appPaths(
  platform: NodeJS.Platform,
  app: "obsidian" | "notion",
  home: string,
  env: (name: string) => string | undefined,
): string[] {
  if (platform === "darwin")
    return [`/Applications/${app === "obsidian" ? "Obsidian" : "Notion"}.app`];
  if (platform !== "win32") return [];
  const local = env("LOCALAPPDATA") ?? join(home, "AppData", "Local");
  if (app === "notion") return [join(local, "Programs", "Notion")];
  return [join(local, "Obsidian"), join(local, "Programs", "obsidian")];
}

/**
 * Obsidian's file is `{ "vaults": { "<id>": { "path": "/abs/…" } } }`. A missing, oversized or
 * malformed file means "no vaults here" — the person may simply not have installed it yet.
 */
async function listedVaults(configs: string[], deadline: AbortSignal): Promise<KnowledgeVault[]> {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const config of configs) {
    for (const path of await pathsIn(config, deadline)) {
      if (seen.has(path) || candidates.length >= MAX_CANDIDATES) continue;
      seen.add(path);
      candidates.push(path);
    }
  }
  // Probes are independent, so they run together; a vault the person moved or deleted is dropped
  // here rather than offered for a one-click add that would then fail.
  const present = await mapLimit(candidates, PROBE_CONCURRENCY, async (path) =>
    (await probe(path, deadline))?.isDirectory() ? path : undefined,
  );
  return present
    .filter((path): path is string => path !== undefined)
    .slice(0, MAX_VAULTS)
    .map((path) => ({ name: vaultName(path), path }));
}

/** The store shows its own name once added; this one only has to fit the contract. */
function vaultName(path: string): string {
  const name = basename(path) || path;
  if (name.length <= MAX_NAME_UNITS) return name;
  const cut = name.slice(0, MAX_NAME_UNITS);
  // The limit counts UTF-16 units, so a cut can land inside a surrogate pair; drop the half.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

async function pathsIn(config: string, deadline: AbortSignal): Promise<string[]> {
  let text: string;
  try {
    const info = await probe(config, deadline);
    if (!info?.isFile() || info.size > MAX_CONFIG_BYTES) return [];
    const content = await bounded(readFile(config, "utf8"), deadline);
    if (content === undefined) return [];
    text = content;
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const vaults = isRecord(parsed) && isRecord(parsed.vaults) ? parsed.vaults : undefined;
    if (!vaults) return [];
    return Object.values(vaults).flatMap((entry) => {
      const path = isRecord(entry) ? entry.path : undefined;
      // Absolute paths only: a relative one would be resolved against the brain's cwd, which is
      // not a folder the person chose.
      return typeof path === "string" && path.length > 0 && path.length <= 32768 && isAbsolute(path)
        ? [path]
        : [];
    });
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Absent, unreadable and too slow all mean "not here"; the caller has nothing better to do. Node
 * cannot cancel a stat, so the scan stops waiting for it and lets the call finish on its own.
 */
async function probe(path: string, deadline: AbortSignal): Promise<Stats | undefined> {
  if (deadline.aborted) return undefined;
  return bounded(stat(path), deadline);
}

/** Resolves with `work` unless the single-probe limit or the scan's deadline comes first. */
function bounded<T>(work: Promise<T>, deadline: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      deadline.removeEventListener("abort", expire);
      resolve(value);
    };
    const expire = () => finish(undefined);
    timer = setTimeout(expire, PROBE_TIMEOUT_MS);
    deadline.addEventListener("abort", expire, { once: true });
    work.then(finish, expire);
  });
}

/** Runs `run` over `items` with at most `limit` in flight, keeping the input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function anyExists(paths: string[], deadline: AbortSignal): Promise<boolean> {
  for (const path of paths) {
    if (await probe(path, deadline)) return true;
  }
  return false;
}
