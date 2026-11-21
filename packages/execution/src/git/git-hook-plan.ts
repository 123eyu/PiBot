import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { canonicalPath, checkedRoot, within } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";
import { verifyWorkspace } from "../sandbox/workspace.ts";
import { runConfigurationGit } from "./git-config-process.ts";
import { gitHookEntry } from "./git-hook-intent.ts";
import { observeLinuxGitHookShell, revalidateLinuxGitHookShell } from "./git-hook-system-shell.ts";
import type {
  GitHookFacts,
  GitHookPlan,
  GitHookPrepareInput,
  GitHookSource,
} from "./git-hook-types.ts";
import {
  gitResourceIdentity,
  gitResourceParent,
  readGitResource,
  sameGitIdentity,
} from "./git-resource-identity.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const gitLocations = [
  "/Library/Developer/CommandLineTools/usr/bin/git",
  "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
];
const ordinary =
  /^(?:user\.(?:name|email)|remote\.[^.]+\.(?:url|fetch|pushurl)|branch\..+\.(?:remote|merge|pushremote)|core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|protecthfs|protectntfs))$/;
const directoryIdentity = (identity: GitHookSource["identity"]) =>
  identity ? { ...identity, size: "0", modifiedNs: "0", changedNs: "0", links: "0" } : undefined;

async function source(
  path: string,
  signal: AbortSignal,
  content = false,
  limit = 65536,
): Promise<GitHookSource & { text?: string }> {
  signal.throwIfAborted();
  const identity = await gitResourceIdentity(path);
  if (!identity) {
    const parent = await gitResourceParent(path);
    if (parent?.type !== "directory" || (await checkedRoot(parent.path)) !== parent.path)
      throw new ExecError("outside_workplace");
    return { path, parent: directoryIdentity(parent) };
  }
  if (identity.type === "directory") {
    if ((await checkedRoot(path)) !== path) throw new ExecError("outside_workplace");
    return { path, identity: directoryIdentity(identity) };
  }
  const read = await readGitResource(path, limit, signal);
  if (!read.hash || !sameGitIdentity(identity, await gitResourceIdentity(path)))
    throw new ExecError("invalid_input");
  return { path, identity, hash: read.hash, ...(content ? { text: read.text } : {}) };
}

async function native(path: string, signal: AbortSignal) {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.uid !== 0 ||
    (info.mode & 0o022) !== 0 ||
    (info.mode & 0o111) === 0 ||
    (await realpath(path)) !== path
  )
    throw new ExecError("invalid_input");
  return source(path, signal, false, 16 * 1024 * 1024);
}

/** Repeated at the final sandbox dispatch, not just when the approval was displayed. */
export async function revalidateGitHook(plan: GitHookPlan, signal: AbortSignal) {
  if (plan.platform !== process.platform || (plan.platform === "linux" && !plan.linuxShell))
    throw new ExecError("authorization_changed");
  if (plan.linuxShell) await revalidateLinuxGitHookShell(plan.linuxShell, signal);
  await verifyWorkspace(plan.rootIdentities, signal);
  for (const expected of plan.sources) {
    const current = await source(expected.path, signal, false, 16 * 1024 * 1024);
    if (
      !sameGitIdentity(expected.identity, current.identity) ||
      !sameGitIdentity(expected.parent, current.parent) ||
      expected.hash !== current.hash
    )
      throw new ExecError("authorization_changed");
  }
  signal.throwIfAborted();
}

/** No personal configuration body is read; actual execution ignores ambient configuration. */
export async function prepareGitHook(
  input: GitHookPrepareInput,
  request: AbortSignal,
): Promise<{ facts: GitHookFacts; plan?: GitHookPlan }> {
  const signal = AbortSignal.any([request, AbortSignal.timeout(10000)]);
  const facts: GitHookFacts = {
    version: 1,
    status: "unsupported",
    reason: "unsupported_scope",
    authority: "none",
  };
  const platform = process.platform;
  if (
    (platform !== "darwin" && platform !== "linux") ||
    input.command !== "git hook run pre-commit"
  )
    return { facts };
  let temp: string | undefined;
  try {
    await verifyWorkspace(input.rootIdentities, signal);
    const cwd = await checkedRoot(input.cwd),
      home = await checkedRoot(input.botHome);
    if (
      cwd !== input.cwd ||
      home !== input.botHome ||
      !input.writeRoots.some((root) => within(root, cwd)) ||
      input.denyWriteRoots.some((root) => within(root, cwd) || within(cwd, root))
    )
      return { facts };
    if (
      !input.rootIdentities.some(
        (root) =>
          root.role !== "readonly" &&
          input.writeRoots.includes(root.canonicalPath) &&
          within(root.canonicalPath, cwd),
      )
    )
      return { facts };
    const gitDir = join(cwd, ".git");
    const gitDirectory = await source(gitDir, signal);
    if (gitDirectory.identity?.type !== "directory") return { facts };
    const sources: GitHookSource[] = [await source(cwd, signal), gitDirectory];
    const head = await source(join(gitDir, "HEAD"), signal, true, 1024);
    if (
      !head.text ||
      !/^(?:ref: refs\/heads\/[A-Za-z0-9_./-]+|[a-f0-9]{40}(?:[a-f0-9]{24})?)\n?$/.test(head.text)
    )
      return { facts };
    sources.push({ path: head.path, identity: head.identity, hash: head.hash });
    for (const name of ["objects", "refs"]) {
      const directory = await source(join(gitDir, name), signal);
      if (directory.identity?.type !== "directory") return { facts };
      sources.push(directory);
    }
    for (const path of [
      join(gitDir, "commondir"),
      join(gitDir, "gitdir"),
      join(gitDir, "worktrees"),
      join(gitDir, "modules"),
      join(gitDir, "config.worktree"),
    ]) {
      const item = await source(path, signal);
      if (item.identity) return { facts };
      sources.push(item);
    }
    const config = await source(join(gitDir, "config"), signal, true);
    if (!config.text || !config.hash || !config.identity) return { facts };
    sources.push({ path: config.path, identity: config.identity, hash: config.hash });
    const hooks = await source(join(gitDir, "hooks"), signal);
    if (hooks.identity?.type !== "directory") return { facts };
    sources.push(hooks);
    const hook = await source(join(gitDir, "hooks", "pre-commit"), signal, true, 32768);
    const entry = hook.text ? gitHookEntry(hook.text) : undefined;
    facts.reason = "unsupported_entry";
    if (
      !entry ||
      (platform === "linux" && entry.program === "/usr/bin/plutil") ||
      !hook.hash ||
      !hook.identity ||
      ((await lstat(hook.path)).mode & 0o111) === 0
    )
      return { facts };
    sources.push({ path: hook.path, identity: hook.identity, hash: hook.hash });
    const programSource = await native(entry.program, signal);
    const linuxShell = platform === "linux" ? await observeLinuxGitHookShell(signal) : undefined;
    if (!linuxShell) sources.push(await native("/bin/sh", signal));
    sources.push(programSource);
    if (entry.program === "/usr/bin/plutil") {
      const operand = entry.args[2] as string;
      const path = resolve(cwd, operand);
      // The trampoline passes the original argv to plutil. Resolving an alias here would pin
      // its destination while leaving the name actually opened by plutil free to change.
      if (
        operand.split(sep).includes("..") ||
        !input.rootIdentities.some((root) => within(root.canonicalPath, path)) ||
        input.denyWriteRoots.some((root) => within(root, path)) ||
        (await canonicalPath(operand, cwd)) !== path
      )
        return { facts };
      const data = await source(path, signal, false, 1024 * 1024);
      if (data.identity?.type !== "file") return { facts };
      sources.push(data);
    }
    let gitProgram: string | undefined;
    for (const candidate of platform === "linux" ? ["/usr/bin/git"] : gitLocations) {
      const identity = await gitResourceIdentity(candidate);
      if (identity) {
        sources.push(await native(candidate, signal));
        gitProgram = candidate;
        break;
      }
    }
    if (!gitProgram) return { facts };
    if (
      ["/bin", "/usr/bin", dirname(gitProgram)].some((path) =>
        input.writeRoots.some((root) => within(root, path)),
      )
    )
      return { facts };
    const privateRoot = await checkedRoot(input.privateTempRoot);
    if (input.writeRoots.some((root) => within(root, privateRoot))) return { facts };
    temp = await mkdtemp(join(privateRoot, "pibot-hook-inspect-"));
    await chmod(temp, 0o700);
    const options = { platform, env: {} };
    facts.reason = "unsupported_config";
    for (const path of [join(home, ".gitconfig"), join(home, ".config", "git", "config")]) {
      const identity = await gitResourceIdentity(path);
      // Presence is determined without opening personal config, following includes or reading values.
      if (identity) return { facts };
      sources.push(await source(path, signal));
    }
    const copy = join(temp, "config");
    await writeFile(copy, config.text, { flag: "wx", mode: 0o600 });
    const parsed = await runConfigurationGit(
      gitProgram,
      ["--file", copy, "--null", "--list"],
      temp,
      options,
      signal,
    );
    const pairs = parsed
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((row) => {
        const split = row.indexOf("\n");
        return [row.slice(0, split), row.slice(split + 1)] as const;
      });
    if (
      pairs.length > 128 ||
      pairs.some(([key]) => !ordinary.test(key)) ||
      pairs.filter(([key]) => key === "core.bare").some(([, value]) => value !== "false") ||
      pairs
        .filter(([key]) => key === "core.repositoryformatversion")
        .some(([, value]) => value !== "0")
    )
      return { facts };
    Object.assign(facts, {
      status: "confirmation-required",
      reason: "once_required",
      cwd,
      hookPath: hook.path,
      hookHash: hook.hash,
      program: entry.program,
      programHash: programSource.hash,
      args: entry.args,
      beforeVersion: digest({
        sources,
        entry,
        cwd,
        home,
        roots: input.rootIdentities,
        writes: input.writeRoots,
        denied: input.denyWriteRoots,
        platform,
        linuxShell,
      }),
    });
    const plan: GitHookPlan = {
      platform,
      ...(linuxShell ? { linuxShell } : {}),
      facts,
      command: input.command,
      cwd,
      botHome: home,
      gitProgram,
      script: hook.text as string,
      sources,
      rootIdentities: input.rootIdentities,
      writeRoots: input.writeRoots,
      denyWriteRoots: input.denyWriteRoots,
    };
    await revalidateGitHook(plan, signal);
    return { facts, plan };
  } catch (error) {
    signal.throwIfAborted();
    if (
      !(error instanceof ExecError) &&
      !(
        error instanceof Error &&
        "code" in error &&
        ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))
      )
    )
      throw error;
    return { facts: { ...facts, status: "unsupported", reason: "changed" } };
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}
