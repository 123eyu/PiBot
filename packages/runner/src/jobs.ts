import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BackgroundJob, ExecutionTarget } from "@pibot/execution";
import { RunnerJobRegistrySchema, RunnerTargetIdSchema } from "@pibot/protocol-base";

const MAX_JOBS = 64;
type JobRecord = ReturnType<typeof RunnerJobRegistrySchema.parse>["jobs"][number];
export class RunnerJobCapacityError extends Error {}

/** Durable process identities let a restarted runner clean jobs it can no longer adopt. */
export async function createRunnerJobRegistry(path: string, targetId: string) {
  RunnerTargetIdSchema.parse(targetId);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const records = new Map<string, JobRecord>();
  try {
    const saved = RunnerJobRegistrySchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (saved.targetId !== targetId) throw new Error("Runner job registry identity mismatch");
    for (const item of saved.jobs) records.set(item.jobId, item);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  let chain = Promise.resolve();
  let failure: unknown;
  let recoveryComplete = false;
  async function persist() {
    const temporary = `${path}.next`;
    const value = RunnerJobRegistrySchema.parse({ targetId, jobs: [...records.values()] });
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  }
  function enqueue(change: () => void) {
    if (failure) return Promise.reject(failure);
    const work = chain.then(async () => {
      if (failure) throw failure;
      change();
      try {
        await persist();
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    chain = work.catch(() => {});
    return work;
  }
  return {
    targetId,
    list: () => [...records.values()].map((item) => structuredClone(item)),
    async recover(target: ExecutionTarget, signal: AbortSignal) {
      if (recoveryComplete) return 0;
      if (!records.size) {
        recoveryComplete = true;
        return 0;
      }
      const remaining = await target.background.killOrphans(
        [...records.values()].map((item) => item.process),
        signal,
      );
      if (!remaining) await enqueue(() => records.clear());
      recoveryComplete = true;
      return remaining;
    },
    track(job: BackgroundJob) {
      return enqueue(() => {
        if (!records.has(job.id) && records.size >= MAX_JOBS)
          throw new RunnerJobCapacityError("Runner background job capacity exhausted");
        records.set(job.id, {
          jobId: job.id,
          logPath: job.logPath,
          process: job.record(),
          updatedAt: new Date().toISOString(),
        });
      });
    },
    remove(jobId: string) {
      return enqueue(() => {
        records.delete(jobId);
      });
    },
    removeRecords(processes: ReadonlyArray<JobRecord["process"]>) {
      const identities = new Set(
        processes.flatMap((record) =>
          record.processes.map((process) => `${process.pid}:${process.started}`),
        ),
      );
      return enqueue(() => {
        for (const [jobId, item] of records)
          if (
            item.process.processes.some((process) =>
              identities.has(`${process.pid}:${process.started}`),
            )
          )
            records.delete(jobId);
      });
    },
    clear() {
      return enqueue(() => records.clear());
    },
    async dispose() {
      await chain;
      if (failure) throw failure;
    },
  };
}
export type RunnerJobRegistry = Awaited<ReturnType<typeof createRunnerJobRegistry>>;
