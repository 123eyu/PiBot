import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { CommandResources } from "../command/command-context.ts";
import { sameFile } from "../core/file-identity.ts";
import { ExecError, type RunCommandOptions } from "../core/types.ts";
import { gitHookEntry, gitHookQuote as quote } from "./git-hook-intent.ts";
import { revalidateGitHook } from "./git-hook-plan.ts";
import { createGitHookSnapshot } from "./git-hook-snapshot.ts";
import { gitHardening } from "./git-program.ts";
import { gitResourceIdentity, sameGitIdentity } from "./git-resource-identity.ts";

/** The private plan is consumed once; no shell or Git configuration write authority is added. */
export async function prepareGitHookExecution(
  input: RunCommandOptions,
  resources: CommandResources,
  signal: AbortSignal,
) {
  const recipe = input.gitHook;
  if (
    !recipe ||
    (process.platform !== "darwin" && process.platform !== "linux") ||
    input.docker ||
    input.outsideSandbox ||
    input.promotion ||
    input.hostSsh ||
    (input.secretEnv && Object.keys(input.secretEnv).length) ||
    typeof recipe.assertCurrentCall !== "function"
  )
    throw new ExecError("isolation_unavailable");
  const { plan, assertCurrentCall } = recipe;
  const entry = gitHookEntry(plan.script);
  if (
    !entry ||
    plan.platform !== process.platform ||
    (plan.platform === "linux" && entry.program === "/usr/bin/plutil") ||
    plan.claimed ||
    plan.command !== input.command ||
    input.command !== "git hook run pre-commit" ||
    resources.cwd !== plan.cwd ||
    resources.home !== plan.botHome ||
    JSON.stringify(plan.rootIdentities) !== JSON.stringify(input.rootIdentities) ||
    JSON.stringify(plan.writeRoots) !== JSON.stringify(input.writeRoots) ||
    JSON.stringify(plan.denyWriteRoots) !== JSON.stringify(input.denyWriteRoots ?? []) ||
    plan.facts.status !== "confirmation-required" ||
    plan.facts.reason !== "once_required" ||
    plan.facts.program !== entry.program ||
    !plan.sources.some(
      (source) => source.path === entry.program && source.hash === plan.facts.programHash,
    ) ||
    JSON.stringify(plan.facts.args) !== JSON.stringify(entry.args) ||
    createHash("sha256").update(plan.script).digest("hex") !== plan.facts.hookHash
  )
    throw new ExecError("authorization_changed");
  assertCurrentCall(plan.facts);
  // Claim before awaiting so cancellation, a stale resource, or a racing dispatch cannot reuse
  // the same approved attempt.
  plan.claimed = true;
  await revalidateGitHook(plan, signal);
  const tempIdentity =
    plan.platform === "linux" ? await gitResourceIdentity(resources.temp) : undefined;
  if (plan.platform === "linux" && tempIdentity?.type !== "directory")
    throw new ExecError("authorization_changed");
  const directory = await mkdtemp(join(resources.temp, "hook-once-"));
  const hooks = join(directory, "hooks"),
    wrapper = join(hooks, "pre-commit");
  let rootHandle: FileHandle | undefined,
    hooksHandle: FileHandle | undefined,
    closed = false;
  const close = async () => {
    if (closed) return;
    try {
      if (rootHandle) {
        const pinned = await rootHandle.stat({ bigint: true }),
          current = await lstat(directory, { bigint: true });
        if (!sameFile(pinned, current) || (await realpath(directory)) !== directory)
          throw new ExecError("authorization_changed");
        await rootHandle.chmod(0o700);
      }
      await hooksHandle?.chmod(0o700);
      await rm(directory, { recursive: true, force: true });
      closed = true;
    } finally {
      await hooksHandle?.close();
      hooksHandle = undefined;
      await rootHandle?.close();
      rootHandle = undefined;
    }
  };
  try {
    rootHandle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    await rootHandle.chmod(0o700);
    await mkdir(hooks, { mode: 0o700 });
    hooksHandle = await open(
      hooks,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const shell = plan.linuxShell?.program ?? "/bin/sh";
    const bytes = `#!${shell}\nexec ${quote(shell)} -c ${quote(plan.script)} ${quote(".git/hooks/pre-commit")}\n`;
    await writeFile(wrapper, bytes, { flag: "wx", mode: 0o500 });
    await hooksHandle.chmod(0o500);
    await rootHandle.chmod(0o500);
    const identities = await Promise.all([directory, hooks, wrapper].map(gitResourceIdentity));
    async function check() {
      assertCurrentCall(plan.facts);
      await revalidateGitHook(plan, signal);
      if (tempIdentity) {
        const current = await gitResourceIdentity(resources.temp);
        if (
          current?.type !== "directory" ||
          current.device !== tempIdentity.device ||
          current.inode !== tempIdentity.inode ||
          (await realpath(resources.temp)) !== resources.temp
        )
          throw new ExecError("authorization_changed");
      }
      for (const [index, path] of [directory, hooks, wrapper].entries()) {
        const now = await gitResourceIdentity(path);
        if (
          !sameGitIdentity(identities[index], now) ||
          (await realpath(path)) !== path ||
          (await lstat(path)).mode & 0o222
        )
          throw new ExecError("authorization_changed");
      }
      if (!(await readFile(wrapper)).equals(Buffer.from(bytes)))
        throw new ExecError("authorization_changed");
      signal.throwIfAborted();
      assertCurrentCall(plan.facts);
    }
    // Fixed variables also exclude cached XDG config created by earlier ordinary commands.
    const environment = [
      "GIT_CONFIG_NOSYSTEM=1",
      "GIT_CONFIG_SYSTEM=/dev/null",
      "GIT_CONFIG_GLOBAL=/dev/null",
      "GIT_CONFIG_COUNT=0",
      "GIT_TERMINAL_PROMPT=0",
      "GIT_ASKPASS=",
      "SSH_ASKPASS=",
      `XDG_CONFIG_HOME=${quote(directory)}`,
    ];
    const argv = [
      plan.gitProgram,
      "--no-replace-objects",
      "--no-lazy-fetch",
      ...gitHardening(plan.platform, plan.gitProgram),
      "--no-pager",
      "-c",
      `core.hooksPath=${hooks}`,
      "-c",
      "core.bare=false",
      "-c",
      `core.worktree=${plan.cwd}`,
      "hook",
      "run",
      "pre-commit",
    ];
    return {
      command: [...environment, ...argv.map(quote)].join(" "),
      denyWriteRoots: [directory],
      ...(plan.platform === "linux"
        ? { snapshot: createGitHookSnapshot(plan, directory, resources.temp, check) }
        : {}),
      check,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
