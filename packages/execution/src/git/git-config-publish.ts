import { constants, fstatSync, fsyncSync, renameSync, unlinkSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { fileIdentity, matchesFileIdentity } from "../core/file-identity.ts";
import { checkedRoot, within } from "../core/paths.ts";
import { ExecError } from "../core/types.ts";
import { assertHooksPathPublication } from "./git-config-hooks-path.ts";
import {
  gitConfigurationChanges,
  gitConfigurationDigest,
  gitConfigurationRequiresConfirmation,
} from "./git-config-intent.ts";
import { knownConfigurationFileBytes } from "./git-config-known-file.ts";
import { verifyRegisteredBranchConfiguration } from "./git-config-managed-plan.ts";
import { validateGitUpstreamObjects } from "./git-config-object-view.ts";
import { editGitConfigurationCopy } from "./git-config-publish-copy.ts";
import {
  configurationHash,
  configurationIdentitySync,
  configurationReadSync,
  pinConfigurationDirectories,
  verifyConfigurationDirectories,
  verifyConfigurationSource,
} from "./git-config-publish-io.ts";
import { gitConfigurationPublicationPlan } from "./git-config-publish-target.ts";
import type {
  GitConfigurationCallRequirement,
  GitConfigurationPublishInput,
  GitConfigurationPublishReceipt,
  GitPublicationDirectory,
  GitPublicationPlan,
} from "./git-config-publish-types.ts";
import { verifyGitUpstream } from "./git-config-upstream.ts";
import { readGitResource, sameGitIdentity } from "./git-resource-identity.ts";

/** A rename with an unprovable outcome must never be automatically replayed. */
export class GitConfigurationPublicationUnconfirmedError extends ExecError {
  readonly publication = "unconfirmed";
  constructor() {
    super("file_failed");
  }
}

function assertCall(
  input: GitConfigurationPublishInput,
  requirement: Readonly<GitConfigurationCallRequirement>,
) {
  if (input.assertCurrentCall.constructor.name === "AsyncFunction")
    throw new ExecError("authorization_changed");
  const result: unknown = input.assertCurrentCall(requirement);
  if (result !== undefined) {
    // An accidental async adapter is rejected; drain its rejection rather than leak an unhandled promise.
    if (result instanceof Promise) void result.catch(() => undefined);
    throw new ExecError("authorization_changed");
  }
}

async function configurationSource(plan: GitPublicationPlan, signal: AbortSignal) {
  if (!sameGitIdentity(plan.expectedIdentity, configurationIdentitySync(plan.targetPath)))
    throw new ExecError("file_conflict");
  if (!plan.expectedIdentity) return { text: "", hash: undefined };
  const before = await readGitResource(plan.targetPath, 65_536, signal);
  if (
    before.text === undefined ||
    !before.hash ||
    (plan.expectedHash && plan.expectedHash !== before.hash) ||
    configurationHash(before.text) !== before.hash
  )
    throw new ExecError("file_conflict");
  if (/^\s*\[\s*include(?:if\b[^\]]*)?\s*\]/im.test(before.text))
    throw new ExecError("invalid_input");
  verifyConfigurationSource(plan, before.hash);
  return { text: before.text, hash: before.hash };
}

/** Internal local recipe only. The caller supplies current policy approval, never shell write roots. */
export async function publishGitConfiguration(
  input: GitConfigurationPublishInput,
  request: AbortSignal,
): Promise<GitConfigurationPublishReceipt> {
  const signal = AbortSignal.any([request, AbortSignal.timeout(10_000)]);
  signal.throwIfAborted();
  const plan = await gitConfigurationPublicationPlan(input, signal);
  const requirement = Object.freeze({
    scope: plan.intent.scope,
    key: plan.intent.key,
    changedKeys: Object.freeze(gitConfigurationChanges(plan.intent).map((change) => change.key)),
    targetPath: plan.targetPath,
    intentDigest: plan.intent.digest,
    beforeVersion: input.preparedFacts.beforeVersion as string,
    explicitConfirmationRequired:
      gitConfigurationRequiresConfirmation(plan.intent) || !!input.hooksPath,
  });
  assertCall(input, requirement);
  if (input.hooksPath)
    assertHooksPathPublication(input.hooksPath, plan.intent, input.preparedFacts, signal, true);
  signal.throwIfAborted();
  const tempRoot = await checkedRoot(input.privateTempRoot);
  if (
    input.writeRoots.some((root) => within(root, tempRoot)) ||
    within(dirname(plan.targetPath), tempRoot)
  )
    throw new ExecError("outside_workplace");
  const pins: GitPublicationDirectory[] = [];
  const lockPath = `${plan.targetPath}.lock`;
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let ownLock: { device: string; inode: string } | undefined;
  let published = false,
    uncertain = false;
  let receipt: GitConfigurationPublishReceipt | undefined;
  let cleanupFailed = false;
  let failed = false;
  let failure: unknown;
  try {
    await pinConfigurationDirectories(plan, pins, signal);
    signal.throwIfAborted();
    try {
      lock = await open(
        lockPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
        0o600,
      );
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST")
        throw new ExecError("busy");
      throw error;
    }
    const locked = fstatSync(lock.fd, { bigint: true });
    ownLock = fileIdentity(locked);
    verifyConfigurationDirectories(pins);
    signal.throwIfAborted();
    const source = await configurationSource(plan, signal);
    const bytes = input.knownFile
      ? knownConfigurationFileBytes(input.knownFile, plan.intent, source.hash as string, true)
      : await editGitConfigurationCopy(
          {
            intent: plan.intent,
            ...(input.hooksPath ? { hooksPath: input.hooksPath } : {}),
            text: source.text,
            privateTempRoot: tempRoot,
            process: input.process,
            ...(plan.registeredBranch ? { managedBranch: plan.registeredBranch.branch } : {}),
            ...(plan.upstream
              ? {
                  objectFormat:
                    plan.upstream.oids[0]?.length === 64 ? ("sha256" as const) : ("sha1" as const),
                }
              : {}),
          },
          signal,
        );
    if (
      plan.intent.scope === "project" &&
      gitConfigurationDigest(bytes.toString("base64")) !== input.preparedFacts.candidateDigest
    )
      throw new ExecError("file_conflict");
    if (plan.upstream) {
      await validateGitUpstreamObjects(
        {
          gitDir: dirname(plan.targetPath),
          oids: plan.upstream.oids,
          program: plan.intent.program,
          privateTempRoot: tempRoot,
          process: input.process,
          assertSources: () => verifyGitUpstream(plan.upstream),
        },
        signal,
      );
      verifyGitUpstream(plan.upstream);
    }
    await lock.writeFile(bytes, { signal });
    // Keep existing ordinary permission bits; a new personal config starts private.
    if (plan.expectedIdentity) {
      await lock.chmod((await lstat(plan.targetPath)).mode & 0o666);
    }
    await lock.sync();
    const hash = configurationHash(bytes);
    const lockIdentity = configurationIdentitySync(lockPath);
    if (
      !lockIdentity ||
      lockIdentity.device !== ownLock.device ||
      lockIdentity.inode !== ownLock.inode
    )
      throw new ExecError("file_conflict");
    receipt = {
      status: "applied",
      scope: plan.intent.scope,
      key: plan.intent.key,
      changedKeys: [...requirement.changedKeys],
      targetPath: plan.targetPath,
      intentDigest: plan.intent.digest,
      beforeVersion: requirement.beforeVersion,
      publishedHash: hash,
      bytes: bytes.length,
      cancelledAfterPublication: false,
      durability: "unconfirmed",
      cleanup: "complete",
      warnings: [],
    };
    // No JS await between the current-call assertion, final physical checks and publication.
    assertCall(input, requirement);
    signal.throwIfAborted();
    verifyConfigurationDirectories(pins);
    verifyConfigurationSource(plan, source.hash);
    verifyGitUpstream(plan.upstream);
    if (input.hooksPath)
      assertHooksPathPublication(input.hooksPath, plan.intent, input.preparedFacts, signal);
    if (plan.registeredBranch) verifyRegisteredBranchConfiguration(plan.registeredBranch);
    const checkedLock = configurationReadSync(lockPath),
      fd = fstatSync(lock.fd, { bigint: true });
    if (
      !sameGitIdentity(lockIdentity, checkedLock.identity) ||
      checkedLock.hash !== hash ||
      !matchesFileIdentity(fd, ownLock) ||
      String(fd.nlink) !== "1"
    )
      throw new ExecError("file_conflict");
    signal.throwIfAborted();
    try {
      renameSync(lockPath, plan.targetPath);
      published = true;
    } catch {
      uncertain = true;
      let current: ReturnType<typeof configurationReadSync>;
      try {
        current = configurationReadSync(plan.targetPath);
      } catch {
        throw new GitConfigurationPublicationUnconfirmedError();
      }
      if (
        current.identity?.device === ownLock.device &&
        current.identity.inode === ownLock.inode &&
        current.hash === hash
      ) {
        published = true;
        receipt.warnings.push("rename_reported_error");
      } else {
        uncertain =
          !sameGitIdentity(current.identity, plan.expectedIdentity) || current.hash !== source.hash;
        if (uncertain) throw new GitConfigurationPublicationUnconfirmedError();
        throw new ExecError("file_failed");
      }
    }
    try {
      verifyConfigurationDirectories(pins);
      const parent = pins.find((pin) => pin.path === dirname(plan.targetPath));
      if (!parent) throw new ExecError("file_failed");
      fsyncSync(parent.handle.fd);
      receipt.durability = "synced";
    } catch {
      receipt.warnings.push("directory_sync_failed");
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (lock && !ownLock) cleanupFailed = true;
    if (lock && ownLock && !published && !uncertain) {
      try {
        // Only the lock's own ancestors decide whether unlinking it is safe; a replaced hooks
        // directory is a refusal reason, not a reason to strand config.lock.
        verifyConfigurationDirectories(pins.filter((pin) => within(pin.path, lockPath)));
        const current = configurationIdentitySync(lockPath);
        if (
          current?.device === ownLock.device &&
          current.inode === ownLock.inode &&
          current.type === "file" &&
          current.links === "1"
        )
          unlinkSync(lockPath);
      } catch {
        cleanupFailed = true;
      }
    }
    for (const handle of [lock, ...pins.map((pin) => pin.handle)]) {
      if (!handle) continue;
      try {
        await handle.close();
      } catch {
        cleanupFailed = true;
      }
    }
    if (published && receipt) {
      receipt.cancelledAfterPublication = signal.aborted;
      if (cleanupFailed) {
        receipt.cleanup = "required";
        receipt.warnings.push("handle_close_failed");
      }
    }
  }
  if (cleanupFailed && !published && !uncertain)
    throw new ExecError("file_failed", "cleanup_failed");
  if (failed) throw failure;
  if (!published || !receipt) throw new GitConfigurationPublicationUnconfirmedError();
  return receipt;
}
