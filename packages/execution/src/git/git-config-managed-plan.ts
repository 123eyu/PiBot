import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { ExecError } from "../core/types.ts";
import {
  type GitConfigurationIntent,
  gitConfigurationBranchName,
  gitConfigurationDigest,
} from "./git-config-intent.ts";
import { configurationIdentitySync, configurationReadSync } from "./git-config-publish-io.ts";
import { gitResourceIdentity, readGitResource, sameGitIdentity } from "./git-resource-identity.ts";
import type { GitResourceIdentity } from "./git-resource-types.ts";

export interface ManagedConfigurationDirectory {
  path: string;
  device: string;
  inode: string;
}
interface ManagedConfigurationFile {
  identity: GitResourceIdentity;
  hash: string;
}
/** Physical expected state, not authority: publishing still requires the current call assertion. */
export interface RegisteredBranchConfigurationPlan {
  purpose: "af8-own-branch-pushremote";
  source: ManagedConfigurationDirectory;
  primary: ManagedConfigurationDirectory;
  git: ManagedConfigurationDirectory;
  common: ManagedConfigurationDirectory;
  branch: string;
  head: string;
  intentDigest: string;
  config: ManagedConfigurationFile;
  files: ManagedConfigurationFile[];
  absentPaths: string[];
  beforeVersion: string;
}

export function managedBranchConfigurationIntent(intent: GitConfigurationIntent, branch: string) {
  return (
    intent.scope === "project" &&
    !intent.recipe &&
    !intent.resolvedBranch &&
    gitConfigurationBranchName(branch) &&
    intent.key === `branch.${branch}.pushremote` &&
    intent.value !== "." &&
    gitConfigurationBranchName(intent.value)
  );
}

function verifyDirectory(expected: ManagedConfigurationDirectory) {
  const now = configurationIdentitySync(expected.path);
  if (
    now?.type !== "directory" ||
    now.device !== expected.device ||
    now.inode !== expected.inode ||
    realpathSync(expected.path) !== expected.path
  )
    throw new ExecError("file_conflict");
}

export function verifyRegisteredBranchConfiguration(plan: RegisteredBranchConfigurationPlan) {
  if (plan.purpose !== "af8-own-branch-pushremote") throw new ExecError("invalid_input");
  for (const directory of [plan.source, plan.primary, plan.git, plan.common])
    verifyDirectory(directory);
  for (const expected of [...plan.files, plan.config]) {
    const now = configurationReadSync(expected.identity.path);
    if (!sameGitIdentity(expected.identity, now.identity) || now.hash !== expected.hash)
      throw new ExecError("file_conflict");
  }
  if (plan.absentPaths.some((path) => configurationIdentitySync(path)))
    throw new ExecError("file_conflict");
}

/** Known AF8 layout only; no ambient Git config, includes, hooks or subprocess is consulted. */
export async function prepareRegisteredBranchConfiguration(
  input: Omit<
    RegisteredBranchConfigurationPlan,
    "purpose" | "config" | "files" | "absentPaths" | "beforeVersion" | "intentDigest"
  > & { intent: GitConfigurationIntent },
  signal: AbortSignal,
): Promise<RegisteredBranchConfigurationPlan> {
  signal.throwIfAborted();
  const { intent } = input;
  if (
    process.platform !== "darwin" ||
    !managedBranchConfigurationIntent(intent, input.branch) ||
    intent.cwd !== input.primary.path ||
    input.common.path !== join(input.source.path, ".git") ||
    !input.git.path.startsWith(`${join(input.common.path, "worktrees")}/`) ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.head)
  )
    throw new ExecError("outside_workplace");
  for (const directory of [input.source, input.primary, input.git, input.common])
    verifyDirectory(directory);
  const files: ManagedConfigurationFile[] = [];
  const read = async (path: string) => {
    signal.throwIfAborted();
    const identity = await gitResourceIdentity(path);
    const result = await readGitResource(path, 65_536, signal);
    if (
      !identity ||
      !result.hash ||
      result.text === undefined ||
      identity.type !== "file" ||
      identity.links !== "1" ||
      !sameGitIdentity(identity, await gitResourceIdentity(path))
    )
      throw new ExecError("file_conflict");
    files.push({ identity, hash: result.hash });
    return result.text;
  };
  const pointer = await read(join(input.primary.path, ".git"));
  const common = await read(join(input.git.path, "commondir"));
  const back = await read(join(input.git.path, "gitdir"));
  const head = await read(join(input.git.path, "HEAD"));
  const ref = await read(join(input.common.path, "refs", "heads", input.branch));
  if (
    !/^gitdir: [^\r\n]+\n?$/.test(pointer) ||
    resolve(input.primary.path, pointer.trim().slice(8)) !== input.git.path ||
    /[\r\n]/.test(common.trim()) ||
    resolve(input.git.path, common.trim()) !== input.common.path ||
    /[\r\n]/.test(back.trim()) ||
    resolve(input.git.path, back.trim()) !== join(input.primary.path, ".git") ||
    head !== `ref: refs/heads/${input.branch}\n` ||
    ref.trim() !== input.head
  )
    throw new ExecError("file_conflict");
  const configPath = join(input.common.path, "config");
  const configIdentity = await gitResourceIdentity(configPath);
  const config = await readGitResource(configPath, 65_536, signal);
  if (
    !configIdentity ||
    !sameGitIdentity(configIdentity, await gitResourceIdentity(configPath)) ||
    !config.hash ||
    config.text === undefined ||
    configIdentity.type !== "file" ||
    configIdentity.links !== "1" ||
    /^\s*\[\s*include(?:if\b[^\]]*)?\s*\]/im.test(config.text)
  )
    throw new ExecError("invalid_input");
  const absentPaths = [
    join(input.git.path, "config.worktree"),
    join(input.common.path, "config.worktree"),
  ];
  const plan: RegisteredBranchConfigurationPlan = {
    purpose: "af8-own-branch-pushremote",
    source: input.source,
    primary: input.primary,
    git: input.git,
    common: input.common,
    branch: input.branch,
    head: input.head,
    intentDigest: intent.digest,
    config: { identity: configIdentity, hash: config.hash },
    files,
    absentPaths,
    beforeVersion: gitConfigurationDigest({
      files,
      config: { identity: configIdentity, hash: config.hash },
      branch: input.branch,
      head: input.head,
    }),
  };
  verifyRegisteredBranchConfiguration(plan);
  const current = await gitResourceIdentity(configPath);
  if (!sameGitIdentity(configIdentity, current)) throw new ExecError("file_conflict");
  for (const directory of [plan.source, plan.primary, plan.git, plan.common])
    Object.freeze(directory);
  for (const file of [...plan.files, plan.config]) {
    Object.freeze(file.identity);
    Object.freeze(file);
  }
  Object.freeze(plan.files);
  Object.freeze(plan.absentPaths);
  return Object.freeze(plan);
}
