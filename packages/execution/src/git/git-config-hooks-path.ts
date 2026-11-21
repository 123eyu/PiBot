import { lstatSync } from "node:fs";
import { join } from "node:path";
import { within } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";
import type { GitConfigurationCandidateInput } from "./git-config-candidate.ts";
import type { GitConfigurationFacts } from "./git-config-facts.ts";
import {
  type HookDirectory,
  hookDirectoryChain,
  verifyHookDirectories,
} from "./git-config-hooks-directories.ts";
import { type GitConfigurationIntent, gitConfigurationDigest } from "./git-config-intent.ts";

interface Binding {
  intent: GitConfigurationIntent;
  callId: string;
  command: string;
  primary: string;
  target: string;
  beforeVersion: string;
  directories: HookDirectory[];
  oldChecked: boolean;
  facts?: string;
  consumed: boolean;
}
const issued = new WeakMap<object, Binding>();
class HooksPathConfigurationPlan {
  declare private readonly brand: never;
}
Object.freeze(HooksPathConfigurationPlan.prototype);

export type { HooksPathConfigurationPlan };

function binding(plan: HooksPathConfigurationPlan | undefined) {
  const data = plan && issued.get(plan);
  if (!data) throw new ExecError("authorization_changed");
  return data;
}
function current(data: Binding, signal: AbortSignal) {
  verifyHookDirectories(data.directories, signal);
}

/** Issues a recipe object, never a directory read/write or hook execution capability. */
export function prepareHooksPathConfiguration(
  input: Omit<GitConfigurationCandidateInput, "hooksPath">,
  request: { callId: string; command: string },
  signal: AbortSignal,
): HooksPathConfigurationPlan {
  signal.throwIfAborted();
  const intent = input.parsed.intent,
    primary = input.rootIdentities.find((root) => root.role === "primary");
  if (
    process.platform !== "darwin" ||
    input.process.platform !== "darwin" ||
    !intent ||
    intent.key !== "core.hookspath" ||
    intent.scope !== "project" ||
    intent.recipe ||
    input.registeredBranch ||
    input.knownFile ||
    !primary ||
    primary.canonicalPath !== intent.cwd ||
    !input.writeRoots.includes(primary.canonicalPath) ||
    !request.callId ||
    !request.command
  )
    throw new ExecError("outside_workplace");
  const target = join(intent.cwd, ".git", "config"),
    source = input.snapshot.resources.find(
      (item) => item.kind === "config" && item.path === target,
    );
  const repo = input.snapshot.repositories.find(
    (item) =>
      item.kind === "ordinary" &&
      item.worktree === intent.cwd &&
      item.gitDir === join(intent.cwd, ".git") &&
      item.commonDir === item.gitDir,
  );
  if (
    !repo ||
    !source?.identity ||
    !source.hash ||
    input.denyWriteRoots.some(
      (root) => within(root, intent.value) || within(intent.value, root) || within(root, target),
    )
  )
    throw new ExecError("outside_workplace");
  try {
    lstatSync(join(intent.cwd, ".git", "config.worktree"));
    throw new ExecError("outside_workplace");
  } catch (error) {
    signal.throwIfAborted();
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const directories = hookDirectoryChain(primary.canonicalPath, intent.value, signal);
  if (directories[0]?.device !== primary.device || directories[0]?.inode !== primary.inode)
    throw new ExecError("authorization_changed");
  const plan = new HooksPathConfigurationPlan();
  Object.freeze(plan);
  issued.set(plan, {
    intent: Object.freeze({ ...intent }),
    ...request,
    primary: primary.canonicalPath,
    target,
    beforeVersion: gitConfigurationDigest({ identity: source.identity, hash: source.hash }),
    directories,
    oldChecked: false,
    consumed: false,
  });
  return plan;
}

/** Called only on the complete no-includes parse of the already-bound source config. */
export function assertHooksPathSource(
  plan: HooksPathConfigurationPlan,
  intent: GitConfigurationIntent,
  rows: Map<string, (string | null)[]>,
  signal: AbortSignal,
) {
  const data = binding(plan),
    values = rows.get("core.hookspath");
  if (
    data.intent.digest !== intent.digest ||
    [...rows.keys()].some(
      (key) =>
        key.startsWith("include.") ||
        key.startsWith("includeif.") ||
        key === "extensions.worktreeconfig",
    )
  )
    throw new ExecError("invalid_input");
  if (values !== undefined) {
    if (values.length !== 1 || typeof values[0] !== "string" || values[0] === intent.value)
      throw new ExecError("invalid_input");
    const old = hookDirectoryChain(data.primary, values[0], signal);
    if (!data.oldChecked)
      for (const item of old)
        if (!data.directories.some((existing) => existing.path === item.path))
          data.directories.push(item);
  }
  data.oldChecked = true;
  current(data, signal);
}
/** Facts cross a zod parse between seal and verify, which rebuilds keys in schema order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, canonical(item)]),
  );
}
function factsDigest(facts: GitConfigurationFacts) {
  return gitConfigurationDigest(canonical(facts));
}
export function sealHooksPathConfiguration(
  plan: HooksPathConfigurationPlan,
  facts: GitConfigurationFacts,
  signal: AbortSignal,
) {
  const data = binding(plan);
  current(data, signal);
  if (
    !data.oldChecked ||
    facts.operation !== "hooks-path" ||
    facts.scope !== "project" ||
    facts.status !== "candidate" ||
    facts.reason !== "hooks_path_candidate" ||
    facts.requestedKey !== data.intent.key ||
    facts.intentDigest !== data.intent.digest ||
    facts.targetPath !== data.target ||
    facts.beforeVersion !== data.beforeVersion ||
    JSON.stringify(facts.changedKeys) !== JSON.stringify([data.intent.key]) ||
    !facts.candidateDigest ||
    facts.hooksPathVersion !== gitConfigurationDigest(data.directories)
  )
    throw new ExecError("authorization_changed");
  data.facts = factsDigest(facts);
}
export function hooksPathConfigurationVersion(plan: HooksPathConfigurationPlan) {
  return gitConfigurationDigest(binding(plan).directories);
}
export function verifyHooksPathConfiguration(
  plan: HooksPathConfigurationPlan | undefined,
  facts: GitConfigurationFacts,
  request: { callId: string; command: string },
  signal: AbortSignal,
  consume = false,
) {
  const data = binding(plan);
  if (
    !data.facts ||
    factsDigest(facts) !== data.facts ||
    request.callId !== data.callId ||
    request.command !== data.command ||
    (consume && data.consumed)
  )
    throw new ExecError("authorization_changed");
  current(data, signal);
  if (consume) data.consumed = true;
}
export function hooksPathConfigurationDirectories(plan: HooksPathConfigurationPlan) {
  return binding(plan).directories.map(({ path, device, inode }) => ({ path, device, inode }));
}
export function assertHooksPathPublication(
  plan: HooksPathConfigurationPlan | undefined,
  intent: GitConfigurationIntent,
  facts: GitConfigurationFacts,
  signal: AbortSignal,
  consume = false,
) {
  const data = binding(plan);
  if (data.intent.digest !== intent.digest) throw new ExecError("authorization_changed");
  verifyHooksPathConfiguration(
    plan,
    facts,
    { callId: data.callId, command: data.command },
    signal,
    consume,
  );
}
