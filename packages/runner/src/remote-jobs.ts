import type { BackgroundJob, RunCommandOptions } from "@pibot/execution";
import { RpcError, RpcErrorCodes, RunnerBackgroundSnapshotSchema } from "@pibot/protocol-base";
import {
  type BackgroundEnd,
  issueKey,
  type Reconciliation,
  type RemoteDeps,
  runnerRootIdentities,
  type Snapshot,
} from "./remote-state.ts";

export async function confirmBackgroundReconciliation(
  deps: RemoteDeps,
  pending: Omit<Reconciliation, "idempotencyKey">,
  signal: AbortSignal,
) {
  const { call, transfer } = deps;
  if (!pending.jobId)
    throw new RpcError(RpcErrorCodes.invalidRequest, "Runner reconciliation missing job identity");
  const descriptor = await call(
    "runner.background.inspect",
    { jobId: pending.jobId, maxChars: 65536 },
    { signal },
  );
  if (!descriptor) throw new RpcError(RpcErrorCodes.closed, "Runner background result unavailable");
  const snapshot = await transfer.pullJson(
    descriptor,
    signal,
    RunnerBackgroundSnapshotSchema.parse,
  );
  if (snapshot.id !== pending.jobId)
    throw new RpcError(RpcErrorCodes.invalidRequest, "Runner background identity changed");
  if (pending.operation === "background.stop" && !snapshot.ended)
    throw new RpcError(RpcErrorCodes.closed, "Runner background stop remains unconfirmed");
}

export function remoteJob(
  deps: RemoteDeps,
  initial: Snapshot,
  runId: string,
  rootIdentities: RunCommandOptions["rootIdentities"],
  onChange?: (job: BackgroundJob) => void,
  onProgress?: (job: BackgroundJob) => void,
): BackgroundJob {
  const { call, link, transfer, jobs, jobCleanups, detachedJobs, isDisconnected } = deps;
  const { pullJson } = transfer;
  let current = initial;
  let endedResolve!: (value: Awaited<BackgroundJob["ended"]>) => void;
  const ended = new Promise<Awaited<BackgroundJob["ended"]>>((resolve) => {
    endedResolve = resolve;
  });
  let finished = false;
  let detached = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = 500;
  const finish = (result: BackgroundEnd) => {
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    jobs.delete(initial.id);
    jobCleanups.delete(initial.id);
    detachedJobs.delete(initial.id);
    endedResolve(result);
  };
  const detach = () => {
    if (finished || detached) return;
    detached = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    detachedJobs.set(initial.id, { jobId: initial.id, runId });
  };
  const refresh = async (maxChars = 65536, signal = link) => {
    const descriptor = await call(
      "runner.background.inspect",
      { jobId: initial.id, maxChars },
      { signal },
    );
    if (!descriptor)
      throw new RpcError(RpcErrorCodes.closed, "Runner background result unavailable");
    const value = await pullJson(descriptor, signal, RunnerBackgroundSnapshotSchema.parse);
    if (value.id !== initial.id)
      throw new RpcError(RpcErrorCodes.invalidRequest, "Runner background identity changed");
    const before = JSON.stringify({
      running: current.running,
      listeners: current.listeners,
      ports: current.ports,
      record: current.record,
      ended: current.ended,
    });
    const progressChanged = current.outputLines !== value.outputLines;
    current = value;
    detached = false;
    detachedJobs.delete(initial.id);
    retryMs = 500;
    const changed =
      before !==
      JSON.stringify({
        running: value.running,
        listeners: value.listeners,
        ports: value.ports,
        record: value.record,
        ended: value.ended,
      });
    if (changed)
      try {
        onChange?.(job);
      } catch {
        // A brain observer cannot change the remote process or transport lifecycle.
      }
    if (progressChanged)
      try {
        onProgress?.(job);
      } catch {
        // Progress is observational; an observer cannot change the remote job lifecycle.
      }
    if (value.ended) {
      finish(value.ended);
      void call(
        "runner.background.ack",
        { jobId: initial.id },
        { signal: AbortSignal.timeout(2_000), timeoutMs: 2_000 },
      ).catch(() => {
        // The runner retains unacknowledged terminal snapshots until its bounded TTL.
      });
    }
    return value;
  };
  const poll = () => {
    if (finished || detached || isDisconnected() || link.aborted) return;
    timer = setTimeout(() => {
      void refresh()
        .then((value) => {
          if (value?.running) poll();
        })
        .catch(() => {
          if (isDisconnected()) {
            detach();
            return;
          }
          // A transient request failure is not evidence that the process ended.
          retryMs = Math.min(retryMs * 2, 5_000);
          poll();
        });
    }, retryMs);
  };
  const job = {
    get id() {
      return current.id;
    },
    get logPath() {
      return current.logPath;
    },
    get running() {
      return current.running;
    },
    get outputLines() {
      return current.outputLines;
    },
    get permissionOnly() {
      return current.permissionOnly;
    },
    get listeners() {
      return current.listeners;
    },
    ports: () => [...current.ports],
    output: (maxChars: number) => current.output.slice(-maxChars),
    record: () => structuredClone(current.record),
    writeInput: async (
      text: string,
      eof: boolean,
      signal: AbortSignal,
      assertAuthorized: () => void | Promise<void>,
    ) => {
      await assertAuthorized();
      const key = issueKey();
      const result = await deps.withDispatch(assertAuthorized, (dispatchOpId) =>
        deps.tracked(
          key,
          "background.write",
          () =>
            call(
              "runner.background.write",
              {
                ...key,
                dispatchOpId,
                jobId: current.id,
                runId,
                text,
                eof,
                rootIdentities: runnerRootIdentities(rootIdentities),
              },
              { signal },
            ),
          { jobId: current.id },
        ),
      );
      await refresh(65536, signal);
      return result;
    },
    async stop() {
      const key = issueKey();
      const { snapshot: value, ended: stopped } = await deps.tracked(
        key,
        "background.stop",
        async () => {
          const descriptor = await call(
            "runner.background.stop",
            { ...key, jobId: current.id },
            { signal: link },
          );
          const snapshot = await pullJson(descriptor, link, RunnerBackgroundSnapshotSchema.parse);
          if (snapshot.id !== current.id || !snapshot.ended)
            throw new RpcError(
              RpcErrorCodes.invalidRequest,
              "Runner stop result missing terminal state",
            );
          return { snapshot, ended: snapshot.ended };
        },
        { jobId: current.id },
      );
      current = value;
      try {
        onChange?.(job);
      } catch {
        // A brain observer cannot change the confirmed stop result.
      }
      finish(stopped);
      void call(
        "runner.background.ack",
        { jobId: initial.id },
        { signal: AbortSignal.timeout(2_000), timeoutMs: 2_000 },
      ).catch(() => {
        // The runner retains unacknowledged terminal snapshots until its bounded TTL.
      });
    },
    ended,
  } satisfies BackgroundJob;
  jobCleanups.set(initial.id, { detach });
  poll();
  return job;
}
