import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkedRoot, within } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";
import type { GitConfigurationCandidateInput } from "./git-config-candidate.ts";
import type { GitConfigurationFacts } from "./git-config-facts.ts";
import {
  type GitConfigurationIntent,
  gitConfigurationDigest,
  gitConfigurationIntent,
} from "./git-config-intent.ts";
import { configurationGitProgram, runConfigurationGit } from "./git-config-process.ts";
import { configurationEntries } from "./git-config-publish-copy.ts";
import { gitResourceIdentity, readGitResource, sameGitIdentity } from "./git-resource-identity.ts";

interface KnownFileData {
  intent: GitConfigurationIntent;
  targetPath: string;
  beforeHash: string;
  beforeVersion: string;
  bytes: Buffer;
  candidateDigest: string;
  consumed: boolean;
  callId: string;
  requestedPath: string;
}

// Only the issuing module retains bytes. A serialized fact or forged prototype grants nothing.
const issued = new WeakMap<object, KnownFileData>();
class KnownGitConfigurationFile {
  declare private readonly brand: never;
}

export type { KnownGitConfigurationFile };

Object.freeze(KnownGitConfigurationFile.prototype);

export function knownConfigurationFileRequestMatches(
  plan: KnownGitConfigurationFile | undefined,
  request: { callId: string; path: string; content: string },
): boolean {
  const data = plan && issued.get(plan);
  return (
    !!data &&
    data.callId === request.callId &&
    data.requestedPath === request.path &&
    data.bytes.equals(Buffer.from(request.content, "utf8")) &&
    data.bytes.toString("utf8") === request.content
  );
}

export function knownConfigurationFileMatches(
  plan: KnownGitConfigurationFile | undefined,
  facts: GitConfigurationFacts,
): boolean {
  const data = plan && issued.get(plan);
  return (
    !!data &&
    facts.operation === "known-file" &&
    facts.status === "candidate" &&
    facts.scope === "project" &&
    facts.reason === "ordinary_project_candidate" &&
    facts.targetPath === data.targetPath &&
    facts.beforeVersion === data.beforeVersion &&
    facts.requestedKey === data.intent.key &&
    facts.intentDigest === data.intent.digest &&
    facts.candidateDigest === data.candidateDigest &&
    JSON.stringify(facts.changedKeys) === JSON.stringify([data.intent.key])
  );
}

/** Only the existing candidate/publisher modules use this; callers cannot supply replacement bytes. */
export function knownConfigurationFileBytes(
  plan: KnownGitConfigurationFile,
  intent: GitConfigurationIntent,
  sourceHash: string,
  consume = false,
): Buffer {
  const data = issued.get(plan);
  if (
    !data ||
    data.intent.digest !== intent.digest ||
    data.beforeHash !== sourceHash ||
    data.candidateDigest !== gitConfigurationDigest(data.bytes.toString("base64")) ||
    (consume && data.consumed)
  )
    throw new ExecError("authorization_changed");
  if (consume) data.consumed = true;
  return Buffer.from(data.bytes);
}

async function changedOrdinaryKey(
  input: Omit<GitConfigurationCandidateInput, "parsed" | "knownFile">,
  before: string,
  after: string,
  cwd: string,
  signal: AbortSignal,
) {
  if (
    /^\s*\[\s*include(?:if\b[^\]]*)?\s*\]/im.test(before) ||
    /^\s*\[\s*include(?:if\b[^\]]*)?\s*\]/im.test(after)
  )
    throw new ExecError("invalid_input");
  const program = await configurationGitProgram("git", input.process);
  if (!program) throw new ExecError("git_unavailable");
  const root = await checkedRoot(input.privateTempRoot);
  if (input.writeRoots.some((path) => within(path, root))) throw new ExecError("outside_workplace");
  const directory = await mkdtemp(join(root, "pibot-git-known-"));
  let result: ReturnType<typeof gitConfigurationIntent> | undefined;
  let failed = false;
  let failure: unknown;
  try {
    const parse = async (name: string, content: string) => {
      const path = join(directory, name);
      await writeFile(path, content, { flag: "wx", mode: 0o600, signal });
      return configurationEntries(
        await runConfigurationGit(
          program,
          ["--file", path, "--null", "--list"],
          directory,
          input.process,
          signal,
        ),
      );
    };
    const original = await parse("before", before),
      candidate = await parse("after", after);
    const keys = new Set([...original.keys(), ...candidate.keys()]);
    const changed: string[] = [];
    for (const key of keys) {
      if (
        key.startsWith("include.") ||
        key.startsWith("includeif.") ||
        key === "extensions.worktreeconfig"
      )
        throw new ExecError("invalid_input");
      if (JSON.stringify(original.get(key)) !== JSON.stringify(candidate.get(key)))
        changed.push(key);
    }
    const key = changed[0],
      previous = key && original.get(key),
      next = key && candidate.get(key);
    if (
      changed.length !== 1 ||
      !key ||
      !/^(?:user\.(?:name|email)|remote\..+\.url)$/.test(key) ||
      previous?.length !== 1 ||
      typeof previous[0] !== "string" ||
      next?.length !== 1 ||
      typeof next[0] !== "string"
    )
      throw new ExecError("invalid_input");
    const originalIntent = gitConfigurationIntent(
      { program: "git", args: ["config", "--local", key, previous[0]] },
      cwd,
    );
    const parsed = gitConfigurationIntent(
      { program: "git", args: ["config", "--local", key, next[0]] },
      cwd,
    );
    if (!originalIntent.intent || !parsed.intent) throw new ExecError("invalid_input");
    result = parsed;
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    const cleanup = new ExecError("file_failed", "cleanup_failed");
    if (failed) throw new AggregateError([failure, cleanup], "Git candidate and cleanup failed");
    throw cleanup;
  }
  if (failed) throw failure;
  if (!result) throw new ExecError("invalid_input");
  return result;
}

/** Prepares exact user bytes in a private plan; it never writes the source repository. */
export async function prepareKnownGitConfigurationFile(
  input: Omit<GitConfigurationCandidateInput, "parsed" | "knownFile"> & {
    path: string;
    content: string;
    callId: string;
    requestedPath: string;
  },
  request: AbortSignal,
): Promise<Pick<GitConfigurationCandidateInput, "parsed" | "knownFile">> {
  const signal = AbortSignal.any([request, AbortSignal.timeout(10_000)]);
  signal.throwIfAborted();
  const bytes = Buffer.from(input.content, "utf8"),
    cwd = dirname(dirname(input.path));
  if (
    process.platform !== "darwin" ||
    input.process.platform !== "darwin" ||
    bytes.length === 0 ||
    bytes.length > 65_536 ||
    bytes.toString("utf8") !== input.content ||
    input.content.includes("\0") ||
    input.path !== join(cwd, ".git", "config") ||
    (await checkedRoot(cwd)) !== cwd ||
    (await checkedRoot(dirname(input.path))) !== dirname(input.path) ||
    input.registeredBranch ||
    (await gitResourceIdentity(join(dirname(input.path), "config.worktree")))
  )
    throw new ExecError("invalid_input");
  const repo = input.snapshot.repositories.find(
    (item) => item.kind === "ordinary" && item.worktree === cwd,
  );
  const expected = input.snapshot.resources.find(
    (item) => item.kind === "config" && item.path === input.path,
  );
  if (
    !repo ||
    repo.gitDir !== dirname(input.path) ||
    repo.commonDir !== repo.gitDir ||
    !expected?.identity ||
    !expected.hash
  )
    throw new ExecError("outside_workplace");
  const before = await readGitResource(input.path, 65_536, signal);
  if (
    before.text === undefined ||
    before.hash !== expected.hash ||
    createHash("sha256").update(before.text).digest("hex") !== before.hash ||
    !sameGitIdentity(expected.identity, await gitResourceIdentity(input.path))
  )
    throw new ExecError("file_conflict");
  const parsed = await changedOrdinaryKey(input, before.text, input.content, cwd, signal);
  if (!parsed.intent) throw new ExecError("invalid_input");
  signal.throwIfAborted();
  const plan = new KnownGitConfigurationFile();
  Object.freeze(plan);
  issued.set(plan, {
    intent: Object.freeze(parsed.intent),
    targetPath: input.path,
    beforeHash: before.hash,
    beforeVersion: gitConfigurationDigest({ identity: expected.identity, hash: before.hash }),
    bytes,
    candidateDigest: gitConfigurationDigest(bytes.toString("base64")),
    consumed: false,
    callId: input.callId,
    requestedPath: input.requestedPath,
  });
  return { parsed, knownFile: plan };
}
