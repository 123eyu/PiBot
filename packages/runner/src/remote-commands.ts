import type { BackgroundProcessRecord, ExecutionTarget } from "@pibot/execution";
import { ExecError } from "@pibot/execution";
import {
  RpcError,
  RpcErrorCodes,
  RunnerBackgroundOrphanResultSchema,
  RunnerBackgroundOrphansSchema,
  RunnerBackgroundSnapshotSchema,
  RunnerOutputChunkSchema,
} from "@pibot/protocol-base";
import { remoteJob } from "./remote-jobs.ts";
import {
  commandInput,
  issueKey,
  type RemoteDeps,
  requireDispatch,
  runnerRootIdentities,
} from "./remote-state.ts";

/** A run release only frees the runner's lease; it must not hold this run's cleanup for long. */
const RELEASE_DEADLINE_MS = 5_000;

/**
 * The command half of the remote target: one long call with a backstop deadline, the lease
 * release, and the background start/write paths that hand the snapshot to a polled job.
 */
export function createCommandChannel(deps: RemoteDeps) {
  const { call, callSignal, jobs, tracked, withDispatch } = deps;
  return {
    async runCommand(input: Parameters<ExecutionTarget["runCommand"]>[0]) {
      // A person confirmed leaving this computer's sandbox, not a remote device's.
      if (input.outsideSandbox) throw new ExecError("isolation_unavailable");
      const confirm = requireDispatch(input.assertAuthorized);
      const key = issueKey();
      const serialized = commandInput(input);
      // The runner enforces `timeoutSec` itself; the desktop keeps the same deadline as a backstop
      // so a device that stops answering cannot leave this command streaming forever.
      const timeoutSec = Math.min(600, Math.max(1, Math.trunc(input.timeoutSec ?? 120)));
      return withDispatch(confirm, (dispatchOpId) =>
        tracked(key, "command.run", async () => {
          try {
            return await call(
              "runner.command.run",
              { ...key, dispatchOpId, input: serialized },
              {
                signal: callSignal(input.signal),
                timeoutMs: Math.max(30_000, timeoutSec * 1000 + 15_000),
                streamSchema: RunnerOutputChunkSchema,
                onStream(chunk) {
                  const output = RunnerOutputChunkSchema.parse(chunk);
                  try {
                    input.onOutput?.(output.text);
                  } catch {
                    // Output consumers do not own the remote process or its transport.
                  }
                },
              },
            );
          } catch (error) {
            // The peer's deadline firing without the runner's own timeout means it went silent.
            if (error instanceof RpcError && error.code === RpcErrorCodes.timeout)
              throw new ExecError("timeout");
            // The runner is pausing new commands while it confirms an earlier cleanup.
            if (error instanceof RpcError && error.code === RpcErrorCodes.runnerCleanupUnconfirmed)
              throw new ExecError("command_failed", "cleanup_unconfirmed");
            throw error;
          }
        }),
      );
    },
    async releaseRun(runId: string) {
      const key = issueKey();
      try {
        await tracked(key, "command.release", () =>
          call(
            "runner.command.release",
            { ...key, runId },
            { signal: deps.link, timeoutMs: RELEASE_DEADLINE_MS },
          ),
        );
      } catch {
        // Releasing only frees the runner's lease. A dropped link or a silent device must not keep
        // this run's write lock and queue slot: a rejected release made the drain unconfirmed and
        // left the whole folder stuck after a runner restart. The runner drops its leases
        // when its own side of the link closes.
      }
    },
    async startBackground(input: Parameters<ExecutionTarget["startBackground"]>[0]) {
      const confirm = requireDispatch(input.assertAuthorized);
      const { callbacks, ...commandInputSource } = input;
      const command = commandInput({
        ...commandInputSource,
        runId: input.runId ?? input.jobId,
      });
      const key = issueKey();
      const snapshot = await tracked(
        key,
        "background.start",
        () =>
          withDispatch(confirm, async (dispatchOpId) => {
            const descriptor = await call(
              "runner.background.start",
              { ...key, dispatchOpId, input: { ...command, jobId: input.jobId } },
              { signal: callSignal(input.signal), timeoutMs: 75_000 },
            );
            const value = await deps.transfer.pullJson(
              descriptor,
              callSignal(input.signal),
              RunnerBackgroundSnapshotSchema.parse,
            );
            if (value.id !== input.jobId)
              throw new RpcError(
                RpcErrorCodes.invalidRequest,
                "Runner background identity changed",
              );
            return value;
          }),
        { jobId: input.jobId },
      );
      const job = remoteJob(
        deps,
        snapshot,
        input.runId ?? input.jobId,
        input.rootIdentities,
        callbacks?.onChange,
        callbacks?.onProgress,
      );
      jobs.set(job.id, job);
      try {
        callbacks?.onChange?.(job);
      } catch {
        // The runner already owns this job; observer failures cannot orphan it.
      }
      return job;
    },
    async writeBackground(input: Parameters<ExecutionTarget["writeBackground"]>[0]) {
      await input.assertAuthorized();
      const key = issueKey();
      return withDispatch(input.assertAuthorized, (dispatchOpId) =>
        tracked(
          key,
          "background.write",
          () =>
            call(
              "runner.background.write",
              {
                ...key,
                dispatchOpId,
                jobId: input.jobId,
                runId: input.runId,
                text: input.text,
                eof: input.eof,
                rootIdentities: runnerRootIdentities(input.rootIdentities),
              },
              { signal: callSignal(input.signal) },
            ),
          { jobId: input.jobId },
        ),
      );
    },
    background: {
      get: (id: string) => jobs.get(id),
      async killOrphans(records: BackgroundProcessRecord[], signal: AbortSignal) {
        signal.throwIfAborted();
        const current = callSignal(signal);
        let remaining = 0;
        for (let offset = 0; offset < records.length; offset += 8) {
          const parsed = RunnerBackgroundOrphansSchema.parse(records.slice(offset, offset + 8));
          const key = issueKey();
          remaining += await tracked(key, "background.killOrphans", async () => {
            const descriptor = await deps.transfer.upload(
              Buffer.from(JSON.stringify(parsed), "utf8"),
              { kind: "background_orphans" },
              current,
              key,
            );
            return (
              await deps.transfer.pullJson(
                descriptor,
                current,
                RunnerBackgroundOrphanResultSchema.parse,
              )
            ).remaining;
          });
        }
        return remaining;
      },
    },
  };
}
