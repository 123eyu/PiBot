import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ExecError,
  type GitWriteOperation,
  gitNetworkSettings,
  gitWriteCommand,
  runGitWriteDirect,
} from "@pibot/execution";
import { type ChangesScope, changesError } from "../changes-scope.ts";
import type { ChangesService } from "../changes-service.ts";
import { probeRepo } from "../git/changes-repo.ts";

export type WriteMode = "sandbox" | "direct";

/** Work files (patch, pathspec, message) live in a fresh directory under the Bot home. */
function resolve(operation: GitWriteOperation, work: string): GitWriteOperation {
  if (operation.kind === "applyReverse")
    return { ...operation, patchFile: join(work, operation.patchFile) };
  if (operation.kind === "commit")
    return {
      ...operation,
      pathspecFile: join(work, operation.pathspecFile),
      messageFile: join(work, operation.messageFile),
    };
  return operation;
}

async function run(
  service: ChangesService,
  scope: ChangesScope,
  mode: WriteMode,
  program: string,
  operations: GitWriteOperation[],
  signal: AbortSignal,
  assertAuthorized?: () => void,
) {
  const root = scope.root.path;
  const { deps } = service.local;
  const probe = await probeRepo(service.reader, root, service.platform, signal);
  if (probe.state !== "repo") throw changesError("changes_not_repo");
  if (probe.state === "repo" && !probe.info.layoutOk) {
    const managed = service.managedLayout;
    if (!managed || !(await managed.allows(scope, signal)))
      throw changesError("changes_readonly_root");
    return managed.write(scope, operations, signal);
  }
  // Windows only, and only from the user's changes.discard / changes.commit clicks.
  if (mode === "direct")
    return runGitWriteDirect(
      {
        platform: deps.platform,
        env: deps.env,
        userHome: deps.userHome,
        resourcesDir: deps.resourcesDir,
      },
      { cwd: root, operations, signal, timeoutMs: 120_000, assertAuthorized },
    );
  const runId = randomUUID();
  try {
    return await service.local.target.runCommand({
      command: operations
        .map((operation) => gitWriteCommand(deps.platform, program, operation))
        .join(" && "),
      cwd: root,
      dataDir: deps.dataDir,
      botHome: scope.home,
      runId,
      writeRoots: [root],
      rootIdentities: [{ canonicalPath: root, device: scope.root.device, inode: scope.root.inode }],
      network: gitNetworkSettings(operations),
      timeoutSec: 120,
      signal,
      assertAuthorized,
    });
  } finally {
    await service.local.target.releaseRun(runId);
  }
}

/**
 * User-initiated Git writes: one at a time per folder, audited as the user's action,
 * and the status cache dropped afterwards whatever the outcome.
 */
export async function executeWrite(
  service: ChangesService,
  scope: ChangesScope,
  input: {
    action: "changes.discard" | "changes.commit" | "changes.refWrite" | "changes.sync";
    failure?: (output: string) => import("@pibot/workspaces-contract/full").ChangesErrorCode;
    verify?: (signal: AbortSignal) => Promise<void>;
    mode: WriteMode;
    program: string;
    operations: GitWriteOperation[];
    files: Record<string, string>;
    facts: { path?: string; target: string; fileCount?: number };
  },
  signal: AbortSignal,
) {
  const probe = await probeRepo(service.reader, scope.root.path, service.platform, signal);
  if (probe.state !== "repo") throw changesError("changes_not_repo");
  if (probe.info.layoutOk) {
    if (!service.userWriteLease) throw changesError("changes_busy");
    return service.userWriteLease(scope, signal, (bound, assertAuthorized) =>
      executeUnlocked(service, scope, input, bound, assertAuthorized),
    );
  }
  return executeUnlocked(service, scope, input, signal);
}

async function executeUnlocked(
  service: ChangesService,
  scope: ChangesScope,
  input: Parameters<typeof executeWrite>[2],
  signal: AbortSignal,
  assertAuthorized?: () => void,
) {
  const root = scope.root.path;
  if (service.writing.has(root)) throw changesError("changes_busy");
  service.writing.add(root);
  const work = join(scope.home, ".pibot", "changes-ops", randomUUID());
  const audit = service.local.approvals.audit;
  const started = performance.now();
  let cleanupUncertain = false;
  const failures: unknown[] = [];
  const detail = {
    toolName: input.action,
    actor: "user" as const,
    cwd: root,
    ...input.facts,
    ...(input.mode === "direct" ? { reasonCode: "windows_unisolated" } : {}),
  };
  try {
    await mkdir(work, { recursive: true, mode: 0o700 });
    for (const [name, content] of Object.entries(input.files))
      await writeFile(join(work, name), content, { mode: 0o600, flag: "wx" });
    audit.append({
      botId: scope.botId,
      kind: "exec.started",
      summary: "Changes action started / 改动操作开始",
      detail,
    });
    let result: Awaited<ReturnType<typeof run>>;
    try {
      await input.verify?.(signal);
      result = await run(
        service,
        scope,
        input.mode,
        input.program,
        input.operations.map((operation) => resolve(operation, work)),
        signal,
        assertAuthorized,
      );
    } catch (error) {
      cleanupUncertain =
        !!error &&
        typeof error === "object" &&
        "reason" in error &&
        error.reason === "cleanup_failed";
      try {
        audit.append({
          botId: scope.botId,
          kind: "exec.finished",
          summary: "Changes action failed / 改动操作失败",
          detail: { ...detail, durationMs: Math.round(performance.now() - started) },
        });
      } catch (auditError) {
        const failures = [error, auditError];
        try {
          service.local.deps.logger.warn("Changes failure audit unavailable");
        } catch (loggingError) {
          failures.push(loggingError);
        }
        const failure = new AggregateError(failures, "Changes error finalization failed", {
          cause: error,
        });
        // Even a second logging failure must not turn an unconfirmed drain into a releasable lock.
        throw cleanupUncertain ? Object.assign(failure, { reason: "cleanup_failed" }) : failure;
      }
      if (error instanceof ExecError && error.code === "busy") throw changesError("changes_busy");
      if (error instanceof ExecError && error.code === "isolation_unavailable")
        throw changesError("changes_isolation_unavailable");
      if (error instanceof ExecError && error.code === "git_unavailable")
        throw changesError("changes_git_unavailable");
      throw error;
    }
    audit.append({
      botId: scope.botId,
      kind: "exec.finished",
      summary: "Changes action finished / 改动操作结束",
      detail: {
        ...detail,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        stopped: result.stopped,
      },
    });
    if (result.exitCode !== 0)
      throw changesError(
        input.failure
          ? input.failure("truncatedOutput" in result ? String(result.truncatedOutput) : "")
          : "changes_write_failed",
      );
  } catch (error) {
    failures.push(error);
  }
  try {
    if (!cleanupUncertain) {
      service.writing.delete(root);
      await rm(work, { recursive: true, force: true }).catch(() =>
        service.local.deps.logger.warn("Changes work directory cleanup failed"),
      );
    }
    service.forget(root);
    service.notify(scope);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    const error = new AggregateError(failures, "Changes finalization failed", {
      cause: failures[0],
    });
    throw cleanupUncertain ? Object.assign(error, { reason: "cleanup_failed" }) : error;
  }
}
