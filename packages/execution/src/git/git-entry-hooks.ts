import { dirname, join } from "node:path";
import {
  type BoundPath,
  EntryScanIncomplete,
  followLink,
  observe,
  readBoundFile,
} from "./git-entry-files.ts";
import { HUSKY_RUNNER_SHA256, HUSKY_STUB_SHA256, hooksFor } from "./git-entry-tables.ts";

interface HookCollector {
  platform: NodeJS.Platform;
}

/** A hook path as Git would run it: the file itself, or the target of a symlinked hook. */
function hookFile(path: string, bindPath: (item: BoundPath) => void) {
  const seen = observe(path);
  bindPath(seen);
  if (seen.kind !== "link") return seen;
  const target = followLink(path);
  if (!target) return { path, kind: "absent" as const };
  const resolved = readBoundFile(target).bound;
  bindPath(resolved);
  return resolved;
}

/**
 * Binds every hook this subcommand may run in `directory` (absent ones too, so a hook created
 * after the card refuses the call). Husky v9.1 stubs resolve to the user's own script; a stub
 * without one runs nothing (owner decision Q3).
 */
export function scanHooks<C extends HookCollector>(
  directory: string,
  subcommand: string,
  args: readonly string[],
  collector: C,
  bind: (collector: C, item: BoundPath) => void,
  add: (
    collector: C,
    entry: { kind: "hook"; name: string; source: string; sha256: string },
  ) => void,
  names: readonly string[] = hooksFor(subcommand, args),
) {
  if (!names.length) return;
  const bindPath = (item: BoundPath) => bind(collector, item);
  const dir = observe(directory);
  bindPath(dir);
  if (dir.kind === "link") {
    const target = followLink(directory);
    if (!target) return;
    const resolved = observe(target);
    bindPath(resolved);
    if (resolved.kind !== "dir") return;
  } else if (dir.kind !== "dir") return;
  let runner: BoundPath | undefined;
  for (const name of names) {
    const path = join(directory, name);
    const hook = hookFile(path, bindPath);
    if (hook.kind === "absent" || hook.kind === "dir") continue;
    if (hook.kind !== "file") throw new EntryScanIncomplete("special_hook");
    // POSIX Git skips (and warns about) a hook without an execute bit; Windows runs any file.
    if (collector.platform !== "win32" && (hook.mode & 0o111) === 0) continue;
    if (hook.sha256 === HUSKY_STUB_SHA256) {
      runner ??= readBoundFile(join(directory, "h")).bound;
      bindPath(runner);
      if (runner.kind === "file" && runner.sha256 === HUSKY_RUNNER_SHA256) {
        // `h` runs `sh -e <dirname(dirname $0)>/<hook>` only when that file exists.
        const user = hookFile(join(dirname(directory), name), bindPath);
        if (user.kind === "absent" || user.kind === "dir") continue;
        if (user.kind !== "file") throw new EntryScanIncomplete("special_hook");
        add(collector, { kind: "hook", name, source: user.path, sha256: user.sha256 });
        continue;
      }
    }
    add(collector, { kind: "hook", name, source: hook.path, sha256: hook.sha256 });
  }
}
