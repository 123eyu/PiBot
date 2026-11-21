import { GitOutputSourceError } from "./git-output-error.ts";

/** Started filesystem work must settle before a failed phase can release its resources. */
export function outputScanBudget(signal: AbortSignal) {
  const deadline = performance.now() + 15_000;
  let failed = false;
  let failure: unknown;
  const remember = (error: unknown) => {
    if (!failed) failure = error;
    failed = true;
  };
  const observe = () => {
    if (signal.aborted) remember(signal.reason);
    if (performance.now() > deadline) remember(new GitOutputSourceError("object_limit"));
  };
  const check = () => {
    observe();
    if (failed) throw failure;
  };
  return {
    remember,
    observe,
    check,
    async read<T>(operation: () => Promise<T>): Promise<T> {
      check();
      try {
        const value = await operation();
        check();
        return value;
      } catch (error) {
        remember(error);
        check();
        throw error;
      }
    },
  };
}
export type OutputScanBudget = ReturnType<typeof outputScanBudget>;

export async function outputScanBatch<T, U>(
  entries: readonly T[],
  budget: OutputScanBudget,
  inspect: (entry: T) => Promise<U>,
): Promise<U[]> {
  const settled = await Promise.allSettled(
    entries.map(async (entry) => {
      try {
        budget.check();
        return await inspect(entry);
      } catch (error) {
        budget.remember(error);
        throw error;
      }
    }),
  );
  budget.check();
  return settled.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}
