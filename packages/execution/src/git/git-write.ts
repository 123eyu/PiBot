import { posix, win32 } from "node:path";
import { ExecError } from "../core/types.ts";
import { type GitNetworkOperation, gitNetworkSteps } from "./git-network.ts";
import { gitHardening } from "./git-program.ts";

/**
 * User-initiated writes from the changes sidebar. The same fixed steps either become
 * a shell string for runCommand's POSIX sandbox (which only accepts a shell string, so exec alone
 * quotes them) or run directly without a shell on Windows (git-write-direct.ts). Variable data
 * (paths, message) reaches Git through NUL-separated files, never through argv or a shell.
 */
export type GitWriteOperation =
  | GitNetworkOperation
  | { kind: "createRef"; ref: string; oid: string }
  | { kind: "switchBranch"; name: string }
  | { kind: "restore"; path: string }
  | { kind: "remove"; path: string }
  | { kind: "deleteUntracked"; absolutePath: string }
  | { kind: "applyReverse"; patchFile: string }
  | {
      kind: "commit";
      pathspecFile: string;
      messageFile: string;
      name: string;
      email: string;
    };

/** One Git invocation (argv after the program) or the deletion of one untracked file. */
export type GitWriteStep = { git: string[] } | { unlink: string };

const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
const unsafe = /[\0\r\n]/;

function relative(platform: NodeJS.Platform, path: string) {
  // Git prints "/" separated paths; Windows also treats "\" as a separator, so it is checked too.
  const windows = platform === "win32";
  if (
    !path ||
    path.length > 4096 ||
    unsafe.test(path) ||
    posix.isAbsolute(path) ||
    (windows && win32.isAbsolute(path)) ||
    path.split(windows ? /[\\/]/ : "/").some((part) => part === ".." || part === "")
  )
    throw new ExecError("invalid_input");
  return path;
}
function absolute(platform: NodeJS.Platform, path: string) {
  if (unsafe.test(path) || !(platform === "win32" ? win32 : posix).isAbsolute(path))
    throw new ExecError("invalid_input");
  return path;
}
/** Identity values become one argv word each; angle brackets would forge a different address. */
export function validGitIdentity(name: string, email: string) {
  return (
    !!name.trim() &&
    !!email.trim() &&
    name.length <= 200 &&
    email.length <= 320 &&
    !/[\p{Cc}<>]/u.test(name) &&
    !/[\p{Cc}<>\s]/u.test(email)
  );
}

export function gitRefName(name: string) {
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(name) ||
    name === "HEAD" ||
    name.startsWith("pibot/") ||
    name.includes("..") ||
    name.includes("//") ||
    name
      .split("/")
      .some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
  )
    throw new ExecError("invalid_input");
  return name;
}

export function gitWriteSteps(
  platform: NodeJS.Platform,
  program: string,
  operation: GitWriteOperation,
): GitWriteStep[] {
  const git = (...args: string[]) => ({
    git: [...gitHardening(platform, absolute(platform, program)), ...args],
  });
  switch (operation.kind) {
    case "sync":
      return gitNetworkSteps(platform, program, operation);
    case "createRef": {
      const prefix = operation.ref.startsWith("refs/heads/") ? "refs/heads/" : "refs/tags/";
      if (
        !operation.ref.startsWith(prefix) ||
        !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(operation.oid)
      )
        throw new ExecError("invalid_input");
      gitRefName(operation.ref.slice(prefix.length));
      // Empty old value requires an absent ref; an existing branch/tag is never overwritten.
      return [git("update-ref", "--no-deref", operation.ref, operation.oid, "")];
    }
    case "switchBranch":
      return [
        git("checkout", "--no-overwrite-ignore", "--no-guess", gitRefName(operation.name), "--"),
      ];
    case "restore":
      // checkout instead of restore: works with Git older than 2.23 and resets index and worktree.
      return [git("checkout", "-q", "HEAD", "--", relative(platform, operation.path))];
    case "remove":
      return [git("rm", "-q", "-f", "--", relative(platform, operation.path))];
    case "deleteUntracked":
      return [{ unlink: absolute(platform, operation.absolutePath) }];
    case "applyReverse":
      return [git("apply", "-R", "--whitespace=nowarn", absolute(platform, operation.patchFile))];
    case "commit": {
      if (!validGitIdentity(operation.name, operation.email)) throw new ExecError("invalid_input");
      const pathspec = [
        `--pathspec-from-file=${absolute(platform, operation.pathspecFile)}`,
        "--pathspec-file-nul",
      ];
      return [
        git("add", "-A", ...pathspec),
        git(
          "-c",
          `user.name=${operation.name}`,
          "-c",
          `user.email=${operation.email}`,
          "commit",
          "-q",
          // Hooks are already unreachable via core.hooksPath; this keeps it so if that ever changes.
          "--no-verify",
          "--cleanup=whitespace",
          "--only",
          "-F",
          absolute(platform, operation.messageFile),
          ...pathspec,
        ),
      ];
    }
  }
}

/** A failed ff-only pull still removes its core-issued temporary fetch ref. */
export function joinGitWriteSteps(operation: GitWriteOperation, commands: string[]) {
  if (operation.kind !== "sync" || operation.action !== "pull") return commands.join(" && ");
  if (commands.length !== 3) throw new ExecError("invalid_input");
  return `{ ${commands[0]}; pibot_sync_status=$?; if [ "$pibot_sync_status" -eq 0 ]; then ${commands[1]}; pibot_sync_status=$?; fi; ${commands[2]}; pibot_sync_cleanup=$?; if [ "$pibot_sync_status" -ne 0 ]; then exit "$pibot_sync_status"; fi; exit "$pibot_sync_cleanup"; }`;
}

/** The POSIX sandbox form: runCommand takes one shell string, so each word is single-quoted. */
export function gitWriteCommand(
  platform: NodeJS.Platform,
  program: string,
  operation: GitWriteOperation,
) {
  // Windows has no command sandbox; its user writes go through runGitWriteDirect.
  if (platform === "win32") throw new ExecError("isolation_unavailable");
  return joinGitWriteSteps(
    operation,
    gitWriteSteps(platform, program, operation).map((step) =>
      "git" in step
        ? [
            ...(operation.kind === "sync"
              ? ["/usr/bin/env", "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never"]
              : []),
            program,
            ...step.git,
          ]
            .map(quote)
            .join(" ")
        : ["/bin/rm", "-f", "--", step.unlink].map(quote).join(" "),
    ),
  );
}
