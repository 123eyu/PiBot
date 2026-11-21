import type { RunCommandOptions } from "@pibot/execution";
import {
  RpcError,
  RpcErrorCodes,
  RunnerBackgroundPageSchema,
  RunnerBackgroundSnapshotSchema,
  RunnerBackgroundSnapshotsSchema,
} from "@pibot/protocol-base";
import { confirmBackgroundReconciliation, remoteJob } from "./remote-jobs.ts";
import type { issueKey, RemoteDeps, Snapshot } from "./remote-state.ts";

const BACKGROUND_PAGE_LIMIT = 8;

/**
 * The idempotency ledger for calls that may have reached the runner before the link dropped, plus
 * the orphaned background jobs a restarted brain has to take back. Both answer "did it happen?"
 * from the runner's own record, never from what this side last saw.
 */
export function createReconcileChannel(deps: RemoteDeps) {
  const { call, callSignal, detachedJobs, isDisconnected, jobs, link, reconciliation, transfer } =
    deps;
  const { pullJson } = transfer;
  return {
    async reconcile(key: ReturnType<typeof issueKey>, signal?: AbortSignal) {
      const result = await call("runner.reconcile", key, {
        signal: signal ? callSignal(signal) : link,
      });
      const held = reconciliation.get(key.idempotencyKey);
      if (result.status === "done") {
        if (
          held &&
          (held.operation === "background.start" || held.operation === "background.stop")
        ) {
          try {
            await confirmBackgroundReconciliation(deps, held, signal ? callSignal(signal) : link);
          } catch (error) {
            reconciliation.set(key.idempotencyKey, {
              ...held,
              state: isDisconnected() ? "detached" : "unknown",
            });
            throw error;
          }
        }
        reconciliation.delete(key.idempotencyKey);
      } else {
        if (held)
          reconciliation.set(key.idempotencyKey, {
            ...held,
            state: result.status === "started" ? "pending" : "unknown",
          });
      }
      return result;
    },
    acknowledgeReconciliation(key: ReturnType<typeof issueKey>) {
      const held = reconciliation.get(key.idempotencyKey);
      if (!held || held.issuedAt !== key.issuedAt || held.state === "pending") return false;
      return reconciliation.delete(key.idempotencyKey);
    },
    pendingReconciliations: () =>
      [...reconciliation].map(([idempotencyKey, details]) => ({ idempotencyKey, ...details })),
    detachedBackgroundJobs: () => [...detachedJobs.values()].map((item) => ({ ...item })),
    async listBackground(signal?: AbortSignal) {
      const current = signal ? callSignal(signal) : link;
      const snapshots: Snapshot[] = [];
      const cursors = new Set<string>();
      let after: string | undefined;
      for (let pageNumber = 0; pageNumber < BACKGROUND_PAGE_LIMIT; pageNumber++) {
        const descriptor = await call(
          "runner.background.list",
          { maxChars: 65536, ...(after ? { after } : {}) },
          { signal: current },
        );
        const page = await pullJson(descriptor, current, RunnerBackgroundPageSchema.parse);
        if (snapshots.length + page.items.length > 64)
          throw new RpcError(
            RpcErrorCodes.invalidRequest,
            "Runner background result exceeded limit",
          );
        let previous = after;
        for (const item of page.items) {
          if (previous !== undefined && item.id.localeCompare(previous) <= 0)
            throw new RpcError(
              RpcErrorCodes.invalidRequest,
              "Runner background page did not advance",
            );
          previous = item.id;
        }
        snapshots.push(...page.items);
        const next = page.nextCursor;
        if (!next) return RunnerBackgroundSnapshotsSchema.parse(snapshots);
        const last = page.items.at(-1)?.id;
        if (!last || next !== last || cursors.has(next))
          throw new RpcError(
            RpcErrorCodes.invalidRequest,
            "Runner background cursor did not advance",
          );
        cursors.add(next);
        after = next;
      }
      throw new RpcError(RpcErrorCodes.invalidRequest, "Runner background page limit exceeded");
    },
    async adoptBackground(
      jobId: string,
      runId: string,
      rootIdentities: RunCommandOptions["rootIdentities"],
      signal?: AbortSignal,
    ) {
      const existing = jobs.get(jobId);
      if (existing) return existing;
      const descriptor = await call(
        "runner.background.inspect",
        { jobId, maxChars: 65536 },
        { signal: signal ? callSignal(signal) : link },
      );
      if (!descriptor) return undefined;
      const current = signal ? callSignal(signal) : link;
      const snapshot = await pullJson(descriptor, current, RunnerBackgroundSnapshotSchema.parse);
      if (snapshot.id !== jobId)
        throw new RpcError(RpcErrorCodes.invalidRequest, "Runner background identity changed");
      const job = remoteJob(deps, snapshot, runId, rootIdentities);
      jobs.set(job.id, job);
      return job;
    },
  };
}
