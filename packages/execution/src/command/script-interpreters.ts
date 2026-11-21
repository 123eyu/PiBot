import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import { ExecError } from "../core/types.ts";

/**
 * Version-manager shims: they pick the real interpreter from files in the working directory
 * (`.python-version`, `.tool-versions`, `.nvmrc`, `mise.toml`), so the program that runs is not
 * the one policy assumed. Matched against the PATH hit and its resolved target.
 */
const SHIM =
  /[/\\](?:\.pyenv|\.asdf|\.rbenv|\.nodenv|\.goenv|\.jenv|\.plenv|\.phpenv|\.luaenv|\.proto|\.rye|mise|rtx)[/\\]shims[/\\]|[/\\]\.volta[/\\]bin[/\\]|[/\\](?:volta-shim|mise|rtx|asdf|pyenv|rbenv|nodenv)(?:\.exe)?$/iu;

/**
 * Security review N2: a "pure" or pinned verdict assumes `python3`, `sh` or `node` is the
 * system interpreter. The command's PATH also carries the user's entries, so the name could
 * resolve into a folder the Bot can write (`.venv/bin`, `node_modules/.bin`, a `bin/` in the
 * workplace) or to a version-manager shim, and code policy never read would run instead.
 * Resolve each interpreter the way the shell will (same PATH, first executable hit) right before
 * dispatch and refuse with `interpreter_untrusted` when it lies in any root the command may
 * write, its home or temp folder, or is a shim. A name that is not found at all is left to fail
 * as "command not found".
 */
export async function verifyScriptInterpreters(
  interpreters: readonly string[] | undefined,
  context: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    home: string;
    temp: string;
    writeRoots: readonly string[];
    rootIdentities?: readonly { canonicalPath: string }[];
  },
  signal: AbortSignal,
): Promise<void> {
  if (!interpreters?.length) return;
  const writable = await Promise.all(
    [
      ...context.writeRoots,
      ...(context.rootIdentities ?? []).map((root) => root.canonicalPath),
      context.cwd,
      context.home,
      context.temp,
    ].map((root) => realpath(root).catch(() => root)),
  );
  const inside = (path: string) =>
    writable.some((root) => {
      const rest = relative(root, path);
      return rest === "" || (!rest.startsWith(`..${sep}`) && rest !== ".." && !isAbsolute(rest));
    });
  const entries = (context.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const name of new Set(interpreters)) {
    signal.throwIfAborted();
    const hit = isAbsolute(name) ? name : await firstExecutable(name, entries, context.cwd);
    if (!hit) continue;
    const target = await realpath(hit).catch(() => hit);
    if (SHIM.test(hit) || SHIM.test(target) || inside(hit) || inside(target))
      throw new ExecError("interpreter_untrusted");
  }
}

async function firstExecutable(name: string, entries: readonly string[], cwd: string) {
  for (const entry of entries) {
    // A relative PATH entry is searched from the working directory, which the Bot can write.
    const candidate = join(isAbsolute(entry) ? entry : join(cwd, entry), name);
    try {
      const info = await stat(candidate);
      if (info.isFile() && (info.mode & 0o111) !== 0) return candidate;
    } catch (error) {
      // Absent here: the shell would look in the next entry too.
      if (!(error instanceof Error && "code" in error)) throw error;
    }
  }
  return undefined;
}
