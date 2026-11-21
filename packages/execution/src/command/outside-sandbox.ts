import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { ExecError } from "../core/types.ts";

/**
 * A person confirmed running one exact command once outside the sandbox. Only objects
 * issued here are accepted, each once, so no other caller can switch a command's isolation off
 * with a flag or a copied object.
 */
export interface OutsideSandboxFilter {
  readonly program: string;
  readonly start: number;
  readonly end: number;
}

export interface OutsideSandboxPermit {
  readonly command: string;
  readonly cwd: string;
  /**
   * Stdin filter stages a listed line relies on, with their command word's offsets in
   * `command`; resolved on the run's PATH and pinned to that absolute path at dispatch.
   */
  readonly filters: readonly OutsideSandboxFilter[];
}

const issued = new WeakSet<OutsideSandboxPermit>();
const consumed = new WeakSet<OutsideSandboxPermit>();

export function issueOutsideSandboxPermit(binding: {
  command: string;
  cwd: string;
  filters?: readonly OutsideSandboxFilter[];
}): OutsideSandboxPermit {
  const permit = Object.freeze({
    command: binding.command,
    cwd: binding.cwd,
    filters: Object.freeze(
      (binding.filters ?? []).map(({ program, start, end }) =>
        Object.freeze({ program, start, end }),
      ),
    ),
  });
  issued.add(permit);
  return permit;
}

/** Spends the permit; a second use, a copy, or another command or folder is refused. */
export function consumeOutsideSandboxPermit(
  permit: OutsideSandboxPermit,
  request: { command: string; cwd: string; platform: NodeJS.Platform },
) {
  if (
    !issued.has(permit) ||
    consumed.has(permit) ||
    (request.platform !== "darwin" && request.platform !== "linux") ||
    permit.command !== request.command ||
    permit.cwd !== request.cwd
  )
    throw new ExecError("authorization_changed");
  consumed.add(permit);
}

/** Where the system's own head/grep/sort live; Homebrew or user folders are not trusted here. */
const SYSTEM_DIRS = new Set(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);

/**
 * A listed line may run `| head -20` outside the sandbox only because head is the
 * system's head. Each name must resolve, in PATH order exactly as the shell would, to a file in a
 * system folder (also after links); anything earlier on PATH with that name, or none, refuses.
 * The returned line has each filter's command word replaced by that absolute path, so the shell
 * does no PATH lookup for it: a `head` planted on PATH after this check cannot be the one run.
 */
export async function pinSystemFilters(
  command: string,
  filters: readonly OutsideSandboxFilter[],
  path: string | undefined,
): Promise<string> {
  let pinned = command;
  // Back to front, so earlier offsets stay valid while later words are replaced.
  for (const filter of [...filters].sort((a, b) => b.start - a.start)) {
    const { program, start, end } = filter;
    if (!/^[A-Za-z0-9._-]+$/.test(program) || command.slice(start, end) !== program)
      throw new ExecError("authorization_changed");
    let found: string | undefined;
    for (const dir of (path ?? "").split(":")) {
      if (!isAbsolute(dir)) continue;
      const candidate = join(dir, program);
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, constants.X_OK);
      } catch {
        // Not on this PATH entry; the shell would look in the next one.
        continue;
      }
      found = candidate;
      break;
    }
    if (!found || !SYSTEM_DIRS.has(dirname(found))) throw new ExecError("authorization_changed");
    if (!SYSTEM_DIRS.has(dirname(await realpath(found))))
      throw new ExecError("authorization_changed");
    pinned = `${pinned.slice(0, start)}${found}${pinned.slice(end)}`;
  }
  return pinned;
}
