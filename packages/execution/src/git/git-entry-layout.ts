import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ConfigEntry, ConfigReader } from "./git-entry-config.ts";
import {
  type BoundPath,
  EntryScanIncomplete,
  followLink,
  observe,
  readBoundFile,
} from "./git-entry-files.ts";

export type GitEntryRefusal =
  | "include_unknown"
  | "layout_unsupported"
  | "scan_incomplete"
  | "compound"
  | "dynamic"
  | "unsupported_target";
export interface GitEntry {
  kind: "hook" | "config";
  name: string;
  source: string;
  sha256: string;
}
const MAX_BOUND = 512;

export class Refused extends Error {
  constructor(readonly reason: GitEntryRefusal) {
    super(reason);
  }
}
export const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export interface Collector {
  entries: GitEntry[];
  bound: BoundPath[];
  reader: ConfigReader;
  deadline: number;
  botHome: string;
  platform: NodeJS.Platform;
}
export function bind(collector: Collector, item: BoundPath) {
  if (collector.bound.length >= MAX_BOUND || Date.now() > collector.deadline)
    throw new EntryScanIncomplete("budget");
  collector.reader.signal.throwIfAborted();
  if (!collector.bound.some((known) => known.path === item.path)) collector.bound.push(item);
}
export function expandHome(path: string, home: string) {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

const SKIPPED = new Set([
  "--no-pager",
  "-P",
  "-p",
  "--paginate",
  "--no-optional-locks",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-replace-objects",
  "--no-lazy-fetch",
  "--no-advice",
]);
const LAYOUT =
  /^--(?:git-dir|work-tree|namespace|bare|exec-path|super-prefix|attr-source|config-env|list-cmds)(?:=|$)/;
const DYNAMIC_VALUE = /[$`]/;

/** Git's global options before the subcommand; anything that moves the layout is refused. */
export function parseInvocation(
  invocation: { args: readonly string[]; cwd: string },
  home: string,
) {
  const args = invocation.args;
  let cwd = invocation.cwd;
  const inline: ConfigEntry[] = [];
  let index = 0;
  for (; index < args.length; index++) {
    const arg = args[index] as string;
    if (!arg.startsWith("-")) break;
    if (SKIPPED.has(arg)) continue;
    if (
      ["--version", "-v", "--help", "-h", "--html-path", "--man-path", "--info-path"].includes(arg)
    )
      return undefined;
    if (arg === "-C") {
      const target = args[++index];
      if (target === undefined || DYNAMIC_VALUE.test(target)) throw new Refused("dynamic");
      if (target) cwd = resolve(cwd, expandHome(target, home));
      continue;
    }
    if (arg === "-c" || (arg.startsWith("-c") && arg.length > 2)) {
      const pair = arg === "-c" ? args[++index] : arg.slice(2);
      if (pair === undefined) throw new Refused("dynamic");
      const equal = pair.indexOf("=");
      inline.push({
        key: equal < 0 ? pair : pair.slice(0, equal),
        value: equal < 0 ? "true" : pair.slice(equal + 1),
      });
      continue;
    }
    if (LAYOUT.test(arg)) throw new Refused("layout_unsupported");
    throw new Refused("dynamic");
  }
  const subcommand = args[index];
  if (subcommand === undefined) return undefined;
  return { cwd, subcommand, rest: args.slice(index + 1), inline };
}

export interface Repository {
  worktree?: string;
  gitDir: string;
  commonDir: string;
}
/** Git's upward discovery: a `.git` directory, a `.git` gitfile, or a bare repository itself. */
export function discover(start: string, collector: Collector): Repository | undefined {
  let directory = start;
  for (let depth = 0; depth < 256; depth++) {
    const dotGit = join(directory, ".git");
    const seen = observe(dotGit);
    if (seen.kind === "dir" || seen.kind === "link") {
      bind(collector, seen);
      const gitDir = followLink(dotGit);
      if (!gitDir) throw new Refused("layout_unsupported");
      return { worktree: directory, gitDir, commonDir: commonDir(gitDir, collector) };
    }
    if (seen.kind === "file") {
      const { bound, bytes } = readBoundFile(dotGit);
      bind(collector, bound);
      const match = /^gitdir: (.+?)\r?\n?$/.exec(bytes?.toString("utf8") ?? "");
      if (!match?.[1]) throw new Refused("layout_unsupported");
      const gitDir = followLink(resolve(directory, match[1]));
      if (!gitDir) throw new Refused("layout_unsupported");
      return { worktree: directory, gitDir, commonDir: commonDir(gitDir, collector) };
    }
    if (seen.kind === "other") throw new Refused("layout_unsupported");
    bind(collector, seen);
    if (
      observe(join(directory, "HEAD")).kind === "file" &&
      observe(join(directory, "objects")).kind === "dir" &&
      observe(join(directory, "refs")).kind === "dir"
    )
      return { gitDir: directory, commonDir: commonDir(directory, collector) };
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  throw new EntryScanIncomplete("depth");
}
function commonDir(gitDir: string, collector: Collector) {
  const { bound, bytes } = readBoundFile(join(gitDir, "commondir"));
  bind(collector, bound);
  if (!bytes) return gitDir;
  const relative = bytes.toString("utf8").trim();
  const common = followLink(isAbsolute(relative) ? relative : resolve(gitDir, relative));
  if (!common) throw new Refused("layout_unsupported");
  return common;
}
