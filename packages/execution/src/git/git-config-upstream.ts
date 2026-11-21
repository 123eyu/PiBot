import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { ExecError } from "../core/types.ts";
import { type GitConfigurationIntent, gitConfigurationBranchName } from "./git-config-intent.ts";
import { type GitObjectObservation, inspectGitObjectView } from "./git-config-object-view.ts";
import { configurationIdentitySync, configurationReadSync } from "./git-config-publish-io.ts";
import { gitResourceIdentity, readGitResource, sameGitIdentity } from "./git-resource-identity.ts";
import type { GitResourceIdentity } from "./git-resource-types.ts";

export interface GitUpstreamSnapshot {
  branch: string;
  oids: string[];
  resources: { path: string; identity?: GitResourceIdentity; hash?: string }[];
  directories: { path: string; device: string; inode: string }[];
  objects: GitObjectObservation[];
}

/** Pre-publication observations only: config.lock does not lock Git's independent refs. */
export function verifyGitUpstream(snapshot: GitUpstreamSnapshot | undefined) {
  if (!snapshot) return;
  for (const item of snapshot.directories) {
    const current = configurationIdentitySync(item.path);
    if (
      current?.type !== "directory" ||
      current.device !== item.device ||
      current.inode !== item.inode
    )
      throw new ExecError("file_conflict");
  }
  for (const item of snapshot.resources) {
    const current = configurationReadSync(item.path);
    if (!sameGitIdentity(item.identity, current.identity) || item.hash !== current.hash)
      throw new ExecError("file_conflict");
  }
  for (const item of snapshot.objects) {
    const current = configurationIdentitySync(item.path);
    if (
      !sameGitIdentity(item.identity, current) ||
      (current && realpathSync(item.path) !== item.path)
    )
      throw new ExecError("file_conflict");
  }
}

export async function resolveGitUpstream(
  intent: GitConfigurationIntent,
  gitDir: string,
  signal: AbortSignal,
): Promise<{ intent: GitConfigurationIntent; upstream?: GitUpstreamSnapshot }> {
  if (intent.recipe?.kind !== "branch-upstream") return { intent };
  const recipe = intent.recipe;
  const snapshot: GitUpstreamSnapshot = {
    branch: "",
    oids: [],
    resources: [],
    directories: [],
    objects: [],
  };
  const seen = new Set<string>();
  const parents = async (path: string) => {
    const parts = relative(gitDir, dirname(path)).split("/").filter(Boolean);
    let directory = gitDir;
    for (const part of ["", ...parts]) {
      signal.throwIfAborted();
      if (part) directory = join(directory, part);
      if (snapshot.directories.some((item) => item.path === directory)) continue;
      const identity = await gitResourceIdentity(directory);
      if (!identity) {
        if (!seen.has(directory)) {
          snapshot.resources.push({ path: directory });
          seen.add(directory);
        }
        return false;
      }
      if (identity.type !== "directory" || (await realpath(directory)) !== directory)
        throw new ExecError("invalid_input");
      snapshot.directories.push({
        path: directory,
        device: identity.device,
        inode: identity.inode,
      });
    }
    return true;
  };
  const read = async (name: string) => {
    signal.throwIfAborted();
    const path = join(gitDir, name);
    if (seen.has(path)) throw new ExecError("invalid_input");
    seen.add(path);
    if (!(await parents(path))) return undefined;
    const identity = await gitResourceIdentity(path);
    if (!identity) {
      snapshot.resources.push({ path });
      return undefined;
    }
    const value = await readGitResource(path, 65_536, signal);
    if (
      value.text === undefined ||
      !value.hash ||
      !sameGitIdentity(identity, await gitResourceIdentity(path))
    )
      throw new ExecError("invalid_input");
    snapshot.resources.push({ path, identity, hash: value.hash });
    return value.text;
  };
  for (const unsupported of [
    "reftable",
    "config.worktree",
    "objects/info/alternates",
    "objects/info/http-alternates",
  ]) {
    if ((await read(unsupported)) !== undefined) throw new ExecError("invalid_input");
  }
  const head = await read("HEAD");
  const current = /^ref: refs\/heads\/([^\r\n]+)\n?$/.exec(head ?? "")?.[1];
  const branch = recipe.localBranch ?? current;
  if (!branch || !gitConfigurationBranchName(branch)) throw new ExecError("invalid_input");
  snapshot.branch = branch;
  const packed = new Map<string, string>();
  let peeled = false;
  for (const line of ((await read("packed-refs")) ?? "").split("\n")) {
    signal.throwIfAborted();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("^")) {
      if (!peeled || !/^\^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(line))
        throw new ExecError("invalid_input");
      peeled = false;
      continue;
    }
    const match = /^([a-f0-9]{40}(?:[a-f0-9]{24})?) (refs\/.+)$/.exec(line);
    if (!match?.[1] || !match[2] || !gitConfigurationBranchName(match[2]) || packed.has(match[2]))
      throw new ExecError("invalid_input");
    packed.set(match[2], match[1]);
    peeled = match[2].startsWith("refs/tags/");
  }
  const values = new Map<string, string | undefined>();
  const ref = async (name: string) => {
    if (values.has(name)) return values.get(name);
    const loose = await read(name);
    if (loose !== undefined && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?\n?$/.test(loose))
      throw new ExecError("invalid_input");
    const value = loose?.trim() ?? packed.get(name);
    values.set(name, value);
    return value;
  };
  const target = `${recipe.name}/${recipe.upstreamBranch}`,
    targetRef = `refs/remotes/${target}`;
  for (const name of [target, `refs/${target}`, `refs/tags/${target}`, `refs/heads/${target}`]) {
    if (await ref(name)) throw new ExecError("invalid_input");
  }
  const localOid = await ref(`refs/heads/${branch}`),
    remoteOid = await ref(targetRef);
  if (!localOid || !remoteOid) throw new ExecError("invalid_input");
  snapshot.oids = [...new Set([localOid, remoteOid])];
  snapshot.objects = await inspectGitObjectView(gitDir, snapshot.oids, signal);
  verifyGitUpstream(snapshot);
  signal.throwIfAborted();
  return {
    intent: { ...intent, key: `branch.${branch}.remote`, resolvedBranch: branch },
    upstream: snapshot,
  };
}
