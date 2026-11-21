import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { ExecError, type ExecOptions } from "../core/types.ts";
import { gitNetworkSettings } from "../git/git-network.ts";
import {
  findGit,
  type GitProcessOptions,
  gitEnvironment,
  killGit,
  spawnGit,
} from "../git/git-process.ts";
import { gitHardening } from "../git/git-program.ts";
import { createGitReader } from "../git/git-read.ts";
import { type GitWriteOperation, gitWriteSteps, joinGitWriteSteps } from "../git/git-write.ts";
import {
  holdManagedPaths,
  type ManagedPathIdentity,
  managedIdentity,
  managedQuote,
} from "./managed-boundary.ts";
import { ManagedExecError } from "./managed-errors.ts";
import { managedWorktreePath } from "./managed-project.ts";
import { runManagedRecipe } from "./managed-recipe.ts";

const oid = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const id = /^[0-9a-f-]{36}$/;
export interface ManagedGitRepository {
  root: ManagedPathIdentity;
  git: ManagedPathIdentity;
  common: ManagedPathIdentity;
  head: string;
  branch: string;
  clean: boolean;
}
export interface ManagedGitAuthority {
  home: string;
  dataDir: string;
  signal: AbortSignal;
  assertAuthorized(): void;
}
export type ManagedGitWrite =
  | {
      kind: "create";
      source: ManagedGitRepository;
      parent: ManagedPathIdentity;
      destination: string;
      managedId: string;
      baseHead: string;
      base?: ManagedGitRepository;
    }
  | {
      kind: "integrate";
      source: ManagedGitRepository;
      target: ManagedGitRepository;
      expectedSourceHead: string;
      expectedTargetHead: string;
      allowMerge?: true;
    }
  | {
      kind: "remove";
      source: ManagedGitRepository;
      worktree: ManagedGitRepository;
      managedId: string;
      parent: ManagedPathIdentity;
      integratedInto?: ManagedGitRepository;
      /** Removes only a verified clean tree; its existing branch and commits remain. */
      preserveBranch?: true;
    };

/** Fixed, bounded Git reads. Configuration values never leave this module or enter a log. */
/**
 * Git for Windows lists worktrees as `C:/x/y` while our identities are `C:\x\y`, and the volume
 * is case-insensitive; an exact string match would refuse every Windows cleanup.
 */
function lockedWorktree(platform: NodeJS.Platform, porcelain: string, path: string, lock: string) {
  const key = (value: string) =>
    platform === "win32" ? win32.normalize(value).toLowerCase() : value;
  const want = key(path);
  return porcelain.split("\0\0").some((block) => {
    const fields = block.split("\0");
    const worktree = fields.find((field) => field.startsWith("worktree "));
    return worktree !== undefined && key(worktree.slice(9)) === want && fields.includes(lock);
  });
}
export function createManagedGit(options: ExecOptions) {
  const lifetime = new AbortController();
  const processOptions: GitProcessOptions = {
    platform: options.platform,
    env: options.env,
    userHome: options.systemHome,
    resourcesDir: options.resourcesDir,
  };
  const reader = createGitReader(processOptions);
  const live = new Set<import("node:child_process").ChildProcess>();
  async function rawRead(cwd: string, args: string[], signal: AbortSignal, maxBytes = 1024 * 1024) {
    signal = AbortSignal.any([signal, lifetime.signal]);
    signal.throwIfAborted();
    const program = await findGit(processOptions);
    if (!program) throw new ExecError("git_unavailable");
    return spawnGit(
      {
        ...processOptions,
        env: { ...gitEnvironment(processOptions, program), GIT_NO_REPLACE_OBJECTS: "1" },
      },
      {
        executable: program,
        args: [...gitHardening(options.platform, program), "--no-optional-locks", ...args],
        cwd,
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        cancelled: () => signal.aborted,
        maxBytes,
        live,
      },
    );
  }
  async function filters(cwd: string, signal: AbortSignal) {
    const result = await rawRead(
      cwd,
      [
        "config",
        "--includes",
        "--name-only",
        "--get-regexp",
        "^filter\\..*\\.(clean|smudge|process|required)$",
      ],
      signal,
      64 * 1024,
    );
    if (result.overflow || (result.exitCode !== 0 && result.exitCode !== 1))
      throw new ManagedExecError("managed_git_config_unavailable");
    const names = new Set([
      "lfs",
      ...result.stdout
        .toString("utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((key) => {
          const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(key);
          if (!match || /[\p{Cc}\p{Cf}]/u.test(key))
            throw new ManagedExecError("managed_git_config_unsafe");
          return match[1] as string;
        }),
    ]);
    if (names.size > 128) throw new ManagedExecError("managed_git_config_unsafe");
    return [...names].flatMap((name) => [
      "-c",
      `filter.${name}.clean=`,
      "-c",
      `filter.${name}.smudge=`,
      "-c",
      `filter.${name}.process=`,
      "-c",
      `filter.${name}.required=false`,
    ]);
  }
  async function read(cwd: string, args: string[], signal: AbortSignal, maxBytes = 1024 * 1024) {
    return rawRead(cwd, [...(await filters(cwd, signal)), ...args], signal, maxBytes);
  }
  async function exists(path: string) {
    try {
      await access(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async function inspect(path: string, signal: AbortSignal): Promise<ManagedGitRepository> {
    signal = AbortSignal.any([signal, lifetime.signal]);
    const root = await managedIdentity(path);
    const probe = await reader.run({ op: "probe" }, { cwd: path, signal, maxBytes: 32 * 1024 });
    // Git for Windows prints `C:/…` even with --path-format=absolute; compare in native form.
    const values = probe.stdout
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((value, index) =>
        options.platform === "win32" && index < 3 ? win32.normalize(value.trim()) : value,
      );
    if (
      probe.exitCode !== 0 ||
      probe.overflow ||
      values.length !== 4 ||
      values[0] !== path ||
      !isAbsolute(values[1] ?? "") ||
      !isAbsolute(values[2] ?? "")
    )
      throw new ManagedExecError("managed_git_layout_unsupported");
    const git = await managedIdentity(values[1] as string),
      common = await managedIdentity(values[2] as string);
    // A config command can execute checkout filters. Refuse such layouts before any write recipe.
    const config = await rawRead(
      path,
      [
        "config",
        "--local",
        "--includes",
        "--get-regexp",
        "^(filter\\..*\\.(clean|smudge|process)|core\\.(attributesfile|sparsecheckout|worktree)|extensions\\.(partialclone|worktreeconfig))$",
      ],
      signal,
      64 * 1024,
    );
    if (
      config.exitCode !== 1 ||
      config.overflow ||
      (await exists(join(common.path, "objects", "info", "alternates"))) ||
      (await exists(join(path, ".gitmodules")))
    )
      throw new ManagedExecError("managed_git_config_unsafe");
    for (const name of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "rebase-apply",
      "rebase-merge",
      "BISECT_LOG",
    ]) {
      if (await exists(join(git.path, name))) throw new ExecError("busy");
    }
    const [head, branch, status, index] = await Promise.all([
      reader.run({ op: "head" }, { cwd: path, signal }),
      read(path, ["symbolic-ref", "--quiet", "HEAD"], signal, 4096),
      read(
        path,
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignored=matching",
          "--ignore-submodules=none",
          "--",
          ".",
        ],
        signal,
      ),
      read(path, ["ls-files", "--stage", "-z", "--", "."], signal),
    ]);
    const hash = head.stdout.toString("utf8").trim(),
      ref = branch.stdout.toString("utf8").trim();
    if (
      head.exitCode !== 0 ||
      !oid.test(hash) ||
      branch.exitCode !== 0 ||
      !ref.startsWith("refs/heads/") ||
      /[\0\r\n]/.test(ref) ||
      status.exitCode !== 0 ||
      status.overflow ||
      index.exitCode !== 0 ||
      index.overflow ||
      /(?:^|\0)160000 /.test(index.stdout.toString("utf8"))
    )
      throw new ManagedExecError("managed_git_layout_unsupported");
    const held = await holdManagedPaths([root, git, common], signal, () => {});
    await held.close();
    const changed = status.stdout.toString("utf8").split("\0").filter(Boolean);
    return {
      root,
      git,
      common,
      head: hash,
      branch: ref,
      clean: changed.every((entry) => entry === "!! .pibot/"),
    };
  }
  async function ancestor(cwd: string, a: string, b: string, signal: AbortSignal) {
    if (!oid.test(a) || !oid.test(b)) throw new ManagedExecError("managed_git_layout_unsupported");
    const result = await read(cwd, ["merge-base", "--is-ancestor", a, b], signal, 4096);
    if (result.exitCode !== 0 && result.exitCode !== 1) throw new ExecError("command_failed");
    return result.exitCode === 0;
  }
  async function write(operation: ManagedGitWrite, authority: ManagedGitAuthority) {
    authority = { ...authority, signal: AbortSignal.any([authority.signal, lifetime.signal]) };
    if (!["darwin", "linux", "win32"].includes(options.platform))
      throw new ExecError("isolation_unavailable");
    const program = await findGit(processOptions);
    if (!program) throw new ExecError("git_unavailable");
    const source = operation.source;
    const quote = managedQuote;
    const hardening = [
      ...gitHardening(options.platform, program),
      ...(await filters(operation.source.root.path, authority.signal)),
      ...(options.platform === "win32" ? ["-c", `safe.directory=${source.root.path}`] : []),
      "--no-replace-objects",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "merge.autoStash=false",
      "-c",
      "core.logAllRefUpdates=true",
    ];
    let args: string[],
      cwd: string,
      identities: ManagedPathIdentity[],
      writes: string[],
      creates: string[] = [],
      denies: string[] = [];
    if (operation.kind === "create") {
      if (
        !id.test(operation.managedId) ||
        !oid.test(operation.baseHead) ||
        operation.baseHead !== (operation.base ?? source).head ||
        (operation.base && operation.base.common.path !== source.common.path) ||
        source.git.path !== join(source.root.path, ".git") ||
        source.common.path !== source.git.path ||
        dirname(operation.destination) !== operation.parent.path ||
        operation.parent.path !== join(source.root.path, ".pibot", "wt") ||
        operation.destination !==
          managedWorktreePath(operation.parent.path, source.root.path, operation.managedId) ||
        (await exists(operation.destination))
      )
        throw new ManagedExecError("managed_git_layout_unsupported");
      args = [
        "worktree",
        "add",
        "--lock",
        "--reason",
        `pibot:${operation.managedId}`,
        "-b",
        `pibot/worktrees/${operation.managedId}`,
        "--",
        operation.destination,
        operation.baseHead,
      ];
      cwd = source.root.path;
      identities = [
        source.root,
        source.git,
        source.common,
        operation.parent,
        ...(operation.base ? [operation.base.root, operation.base.git] : []),
      ];
      writes = [
        operation.destination,
        join(source.common.path, "worktrees"),
        join(source.common.path, "refs", "heads", "pibot"),
        join(source.common.path, "logs", "refs", "heads", "pibot"),
        join(source.common.path, "packed-refs.lock"),
      ];
      // packed-refs.lock is a file Git takes only to delete a packed ref; it stays absent.
      creates = writes.slice(0, 4);
    } else if (operation.kind === "integrate") {
      const target = operation.target;
      if (operation.allowMerge) {
        const drivers = await rawRead(
          target.root.path,
          ["config", "--includes", "--name-only", "--get-regexp", "^merge\\..*\\.driver$"],
          authority.signal,
          64 * 1024,
        );
        if (drivers.exitCode !== 1 || drivers.overflow)
          throw new ManagedExecError("managed_git_config_unsafe");
      }
      if (
        !source.clean ||
        !target.clean ||
        source.common.path !== target.common.path ||
        source.head !== operation.expectedSourceHead ||
        target.head !== operation.expectedTargetHead ||
        (!operation.allowMerge &&
          !(await ancestor(target.root.path, target.head, source.head, authority.signal)))
      )
        throw new ExecError("file_conflict");
      args = [
        ...(operation.allowMerge
          ? ["-c", "user.name=Pi Bot", "-c", "user.email=pibot@localhost"]
          : []),
        "merge",
        ...(operation.allowMerge ? ["--ff"] : ["--ff-only"]),
        "--no-autostash",
        "--no-overwrite-ignore",
        "--no-edit",
        "--no-gpg-sign",
        ...(operation.allowMerge ? ["-m", "chore: integrate group member task outputs"] : []),
        source.head,
      ];
      cwd = target.root.path;
      identities = [source.root, source.git, source.common, target.root, target.git];
      writes = [
        target.root.path,
        target.git.path,
        join(source.common.path, "objects"),
        join(source.common.path, "refs", "heads"),
        join(source.common.path, "logs", "refs", "heads"),
      ];
      creates = [join(source.common.path, "logs", "refs", "heads")];
    } else {
      const target = operation.worktree;
      if (
        !target.clean ||
        dirname(target.root.path) !== operation.parent.path ||
        target.common.path !== source.common.path ||
        target.branch !== `refs/heads/pibot/worktrees/${operation.managedId}` ||
        (operation.integratedInto && operation.integratedInto.common.path !== source.common.path) ||
        (!operation.preserveBranch &&
          !(await ancestor(
            source.root.path,
            target.head,
            (operation.integratedInto ?? source).head,
            authority.signal,
          )))
      )
        throw new ExecError("file_conflict");
      const locked = await read(
        source.root.path,
        ["worktree", "list", "--porcelain", "-z"],
        authority.signal,
      );
      const expected = `locked pibot:${operation.managedId}`;
      if (
        locked.exitCode !== 0 ||
        locked.overflow ||
        !lockedWorktree(
          options.platform,
          locked.stdout.toString("utf8"),
          target.root.path,
          expected,
        )
      )
        throw new ManagedExecError("managed_git_layout_unsupported");
      args = ["worktree", "unlock", "--", target.root.path];
      cwd = source.root.path;
      identities = [
        source.root,
        source.git,
        source.common,
        target.root,
        target.git,
        operation.parent,
        ...(operation.integratedInto
          ? [operation.integratedInto.root, operation.integratedInto.git]
          : []),
      ];
      // bubblewrap makes every write path its own bind mount, and a mount point cannot be
      // deleted (EBUSY). On Linux the tree and its admin folder are writable through their parents
      // only; the capability is the same, since parent and `worktrees` already hold them.
      writes = [
        operation.parent.path,
        ...(options.platform === "linux" ? [] : [target.root.path, target.git.path]),
        join(source.common.path, "worktrees"),
      ];
    }
    denies = [
      join(source.common.path, "config"),
      join(source.common.path, "hooks"),
      ...(operation.kind === "remove"
        ? []
        : identities.map((value) => join(value.path, "config.worktree"))),
    ];
    const gitPrefix =
      options.platform === "win32"
        ? [program, "-C", cwd, ...hardening]
        : [
            "/usr/bin/env",
            "GIT_CONFIG_GLOBAL=/dev/null",
            "GIT_CONFIG_SYSTEM=/dev/null",
            "GIT_CONFIG_NOSYSTEM=1",
            program,
            "-C",
            cwd,
            ...hardening,
          ];
    let command = [...gitPrefix, ...args].map(quote).join(" ");
    if (operation.kind === "remove") {
      const remove = [...gitPrefix, "worktree", "remove", "--", operation.worktree.root.path]
        .map(quote)
        .join(" ");
      const relock = [
        ...gitPrefix,
        "worktree",
        "lock",
        "--reason",
        `pibot:${operation.managedId}`,
        "--",
        operation.worktree.root.path,
      ]
        .map(quote)
        .join(" ");
      command += ` && { ${remove} || { ${relock}; exit 1; }; }`;
    }
    if (operation.kind === "integrate" && operation.allowMerge) {
      const abort = [...gitPrefix, "merge", "--abort"].map(quote).join(" ");
      command += ` || { ${abort}; exit 1; }`;
    }
    return runManagedRecipe(options, {
      ...authority,
      // SRT anchors mandatory editor/agent config denies at its host cwd. A fixed
      // Git checkout/removal must handle tracked config files in the authorized tree;
      // keep the host outside that tree, with Git -C and exact write capabilities.
      cwd: join(options.tempDir, "managed-operations"),
      identities,
      writePaths: writes,
      createDirectories: creates,
      denyPaths: denies,
      command,
      ...(options.platform === "win32"
        ? {
            windowsSteps:
              operation.kind === "remove"
                ? [
                    { executable: program, args: ["-C", cwd, ...hardening, ...args] },
                    {
                      executable: program,
                      args: [
                        "-C",
                        cwd,
                        ...hardening,
                        "worktree",
                        "remove",
                        "--",
                        operation.worktree.root.path,
                      ],
                    },
                  ]
                : [{ executable: program, args: ["-C", cwd, ...hardening, ...args] }],
            ...(operation.kind === "remove"
              ? {
                  windowsRollback: {
                    executable: program,
                    args: [
                      "-C",
                      cwd,
                      ...hardening,
                      "worktree",
                      "lock",
                      "--reason",
                      `pibot:${operation.managedId}`,
                      "--",
                      operation.worktree.root.path,
                    ],
                  },
                }
              : {}),
            ...(operation.kind === "integrate" && operation.allowMerge
              ? {
                  windowsRollback: {
                    executable: program,
                    args: ["-C", cwd, ...hardening, "merge", "--abort"],
                  },
                }
              : {}),
          }
        : {}),
      label: "managed_git",
      ...(operation.kind === "remove"
        ? { removedPaths: [operation.worktree.root.path, operation.worktree.git.path] }
        : {}),
      beforeDispatch: async () => {
        const fresh = await inspect(source.root.path, authority.signal);
        if (fresh.head !== source.head || fresh.branch !== source.branch)
          throw new ExecError("file_conflict");
        if (operation.kind === "create" && operation.base) {
          const base = await inspect(operation.base.root.path, authority.signal);
          if (
            !base.clean ||
            base.head !== operation.baseHead ||
            base.common.path !== source.common.path
          )
            throw new ExecError("file_conflict");
        } else if (operation.kind === "integrate") {
          const target = await inspect(operation.target.root.path, authority.signal);
          if (
            !fresh.clean ||
            !target.clean ||
            target.head !== operation.target.head ||
            target.branch !== operation.target.branch
          )
            throw new ExecError("file_conflict");
        } else if (operation.kind === "remove") {
          const target = await inspect(operation.worktree.root.path, authority.signal);
          if (!target.clean || target.head !== operation.worktree.head)
            throw new ExecError("file_conflict");
          if (operation.integratedInto) {
            const witness = await inspect(operation.integratedInto.root.path, authority.signal);
            if (
              witness.head !== operation.integratedInto.head ||
              witness.common.path !== source.common.path
            )
              throw new ExecError("file_conflict");
          }
        }
      },
    });
  }
  async function writeChanges(
    repository: ManagedGitRepository,
    operations: GitWriteOperation[],
    authority: ManagedGitAuthority,
  ) {
    authority = { ...authority, signal: AbortSignal.any([authority.signal, lifetime.signal]) };
    if (
      !/^refs\/heads\/pibot\/worktrees\/[0-9a-f-]{36}$/.test(repository.branch) ||
      !operations.length ||
      operations.length > 500
    )
      throw new ManagedExecError("managed_git_layout_unsupported");
    const program = await findGit(processOptions);
    if (!program) throw new ExecError("git_unavailable");
    const filterArgs = await filters(repository.root.path, authority.signal);
    const steps = operations.map((operation) =>
      gitWriteSteps(options.platform, program, operation),
    );
    // Windows runs each step as its own process (no shell). The pull form's cleanup-on-failure
    // and the sandbox's `rm -f` have no process equivalent here, so they stay POSIX-only.
    const windowsSteps =
      options.platform === "win32"
        ? steps.flat().map((step) => {
            if (!("git" in step) || operations.some((entry) => entry.kind === "sync"))
              throw new ManagedExecError("managed_git_layout_unsupported");
            return {
              executable: program,
              args: [
                ...filterArgs,
                "-c",
                `safe.directory=${repository.root.path}`,
                "-c",
                "commit.gpgSign=false",
                "--no-replace-objects",
                ...step.git,
              ],
            };
          })
        : undefined;
    const command = operations
      .map((operation, index) =>
        joinGitWriteSteps(
          operation,
          (steps[index] ?? []).map((step) =>
            "git" in step
              ? [
                  "/usr/bin/env",
                  "GIT_CONFIG_GLOBAL=/dev/null",
                  "GIT_CONFIG_SYSTEM=/dev/null",
                  "GIT_CONFIG_NOSYSTEM=1",
                  ...(operations.some((entry) => entry.kind === "sync")
                    ? ["GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never"]
                    : []),
                  program,
                  ...filterArgs,
                  "-c",
                  "commit.gpgSign=false",
                  "--no-replace-objects",
                  ...step.git,
                ]
                  .map(managedQuote)
                  .join(" ")
              : ["/bin/rm", "-f", "--", step.unlink].map(managedQuote).join(" "),
          ),
        ),
      )
      .join(" && ");
    const before = performance.now();
    const syncing = operations.some((operation) => operation.kind === "sync");
    const result = await runManagedRecipe(options, {
      ...authority,
      ...(syncing ? { network: gitNetworkSettings(operations), returnFailure: true } : {}),
      cwd: repository.root.path,
      identities: [repository.root, repository.git, repository.common],
      writePaths: [
        repository.root.path,
        repository.git.path,
        join(repository.common.path, "objects"),
        join(repository.common.path, "refs", "heads", "pibot"),
        join(repository.common.path, "logs", "refs", "heads", "pibot"),
        join(repository.common.path, "packed-refs.lock"),
        ...(syncing
          ? [
              join(repository.common.path, "refs", "pibot-sync"),
              join(repository.common.path, "shallow"),
              join(repository.common.path, "shallow.lock"),
            ]
          : []),
      ],
      // `git pack-refs` (gc) removes emptied loose-ref directories; the branch may need them back.
      createDirectories: [
        join(repository.common.path, "refs", "heads", "pibot"),
        join(repository.common.path, "logs", "refs", "heads", "pibot"),
        ...(syncing ? [join(repository.common.path, "refs", "pibot-sync")] : []),
      ],
      denyPaths: [join(repository.common.path, "config"), join(repository.common.path, "hooks")],
      command,
      ...(windowsSteps ? { windowsSteps } : {}),
      label: "managed_git",
      beforeDispatch: async () => {
        const fresh = await inspect(repository.root.path, authority.signal);
        if (fresh.head !== repository.head || fresh.branch !== repository.branch)
          throw new ExecError("file_conflict");
      },
    });
    const after = await inspect(repository.root.path, authority.signal);
    if (after.branch !== repository.branch) throw new ExecError("file_conflict");
    return {
      ...result,
      durationMs: Math.round(performance.now() - before),
      timedOut: false,
      stopped: false,
    };
  }
  async function ownsLock(cwd: string, path: string, managedId: string, signal: AbortSignal) {
    const locked = await read(cwd, ["worktree", "list", "--porcelain", "-z"], signal);
    return (
      locked.exitCode === 0 &&
      !locked.overflow &&
      lockedWorktree(
        options.platform,
        locked.stdout.toString("utf8"),
        path,
        `locked pibot:${managedId}`,
      )
    );
  }
  return {
    inspect,
    ancestor,
    write,
    writeChanges,
    ownsLock,
    dispose: () => {
      lifetime.abort();
      reader.dispose();
      for (const child of live) killGit(processOptions, child);
    },
  };
}
export type ManagedGit = ReturnType<typeof createManagedGit>;
