import { ExecError } from "@pibot/execution";
import { type acquireRunnerLock, removeRunnerState, writeRunnerState } from "./state.ts";

function drainFailed(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.some(drainFailed);
  return (
    error instanceof ExecError &&
    (error.reason === "cleanup_failed" ||
      (error.code === "command_failed" && error.reason === "timeout"))
  );
}

export class RunnerDrainIncompleteError extends AggregateError {
  constructor(errors: unknown[]) {
    super(errors, "drain_incomplete");
  }
}

/** Ownership must survive an unconfirmed execution drain, even if writing the marker also fails. */
export async function finalizeRunnerOwner(options: {
  dataDir: string;
  deviceId: string;
  lock: Awaited<ReturnType<typeof acquireRunnerLock>>;
  dispose(): Promise<void>;
}) {
  const errors: unknown[] = [];
  let incomplete = false;
  try {
    await options.dispose();
  } catch (error) {
    errors.push(error);
    incomplete = drainFailed(error);
  }
  if (incomplete) {
    await writeRunnerState(options.dataDir, {
      pid: process.pid,
      startedAt: options.lock.startedAt,
      deviceId: options.deviceId,
      status: "drain_incomplete",
    }).catch((error: unknown) => errors.push(error));
    await options.lock.retain().catch((error: unknown) => errors.push(error));
    throw new RunnerDrainIncompleteError(errors);
  }
  await removeRunnerState(options.dataDir).catch((error: unknown) => errors.push(error));
  await options.lock.release().catch((error: unknown) => errors.push(error));
  if (errors.length) throw new AggregateError(errors, "runner_cleanup_failed");
}
