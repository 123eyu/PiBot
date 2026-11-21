import { win32 } from "node:path";

/**
 * Repository configuration can name programs (fsmonitor, hooks, pagers, external diff, transports).
 * These overrides keep reads and the user's writes from running them. Filter drivers have no global
 * off switch; they come from user/system config, which the Bot cannot write.
 *
 * Hooks are off on every platform. core.hooksPath points at a regular file: Git looks for
 * `<hooksPath>/<hook>`, which cannot exist under a file, whereas `--no-verify` alone still runs
 * prepare-commit-msg, post-commit and reference-transaction. POSIX uses /dev/null. On Windows it
 * is the fixed Git executable itself, verified on Git 2.54.0.windows.1: Git for Windows
 * resolves a drive-less "/dev/null" to `<current drive>:\dev\null`, and ordinary users may create
 * folders in a drive root; a relative `NUL` resolves inside the worktree, where a `\\?\` path can
 * plant a real `NUL` directory. The executable comes from a fixed install location, so whoever
 * could replace it could replace Git anyway.
 */
export function gitHardening(platform: NodeJS.Platform, program: string) {
  const common = [
    "--literal-pathspecs",
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${platform === "win32" ? program : "/dev/null"}`,
    "-c",
    "core.pager=cat",
    "-c",
    "core.quotepath=false",
    "-c",
    "color.ui=false",
    "-c",
    "diff.external=",
    "-c",
    "log.showSignature=false",
    "-c",
    "protocol.allow=never",
    "-c",
    "credential.helper=",
    "-c",
    "submodule.recurse=false",
    "-c",
    "gc.auto=0",
    "-c",
    "maintenance.auto=false",
  ];
  if (platform !== "win32") return common;
  // Git for Windows has executable configuration hooks beyond the POSIX hook path.
  // These fixed empty values prevent repository config from selecting a process.
  return [
    ...common,
    "-c",
    "core.sshCommand=",
    "-c",
    "filter.lfs.clean=",
    "-c",
    "filter.lfs.smudge=",
    "-c",
    "filter.lfs.process=",
    "-c",
    "filter.lfs.required=false",
  ];
}

/**
 * Fixed install locations only; PATH lookup could pick a Bot-planted `git`. On macOS the
 * /usr/bin/git shim is avoided because it opens the developer-tools installer when tools are absent.
 */
export function gitPrograms(
  platform: NodeJS.Platform,
  env: Readonly<NodeJS.ProcessEnv>,
  resourcesDir?: string,
) {
  if (platform === "darwin")
    return [
      "/opt/homebrew/bin/git",
      "/usr/local/bin/git",
      "/Library/Developer/CommandLineTools/usr/bin/git",
      "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
    ];
  if (platform === "win32") {
    const value = (name: string) =>
      Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
    return [value("ProgramW6432"), value("ProgramFiles"), value("ProgramFiles(x86)")]
      .filter((base): base is string => !!base && win32.isAbsolute(base))
      .map((base) => win32.join(base, "Git", "cmd", "git.exe"))
      .concat(
        value("LOCALAPPDATA") && win32.isAbsolute(value("LOCALAPPDATA") as string)
          ? [win32.join(value("LOCALAPPDATA") as string, "Programs", "Git", "cmd", "git.exe")]
          : [],
      )
      .concat(
        // Packaged Windows builds ship MinGit (most Windows computers have no Git). It is last so
        // the user's own Git, with their credential manager and LFS, wins. It lives inside Pi Bot's
        // own install, so whoever could replace it could replace Pi Bot. Dev runs have none.
        resourcesDir && win32.isAbsolute(resourcesDir) && !/[\0\r\n]/.test(resourcesDir)
          ? [win32.join(resourcesDir, "bin", "git", "cmd", "git.exe")]
          : [],
      );
  }
  return ["/usr/bin/git", "/usr/local/bin/git", "/bin/git"];
}
