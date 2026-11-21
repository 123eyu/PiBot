/**
 * Per-file search work is IO-bound. A whole-repo `search_text` took over 20 s on a loaded
 * machine (2026-11-05, load ~150) while the 5,495-entry directory walk itself took ~4 s; the rest
 * was one file read at a time. 16 parallel readers keeps the disk busy without opening so many
 * files that a busy machine starts thrashing, which is also roughly what ripgrep does per thread.
 */
export const FILE_CONCURRENCY = 16;

export interface FilePool<Result> {
  /** True once work stopped (cap reached or a failure); the walk can stop feeding files. */
  readonly stopped: boolean;
  /** First rejection, kept until drain so a partial search can still be reported. */
  readonly failure: { readonly error: unknown } | undefined;
  /** Aborts once the pool stops (cap or failure): a producer still listing files can quit now. */
  readonly halted: AbortSignal;
  /** Queues one file, runs it now when a slot is free, and returns its merge position. */
  submit(work: () => Promise<Result>): number;
  /** Drops files that never started; a file already being read still finishes on its own. */
  stop(): void;
  /** Waits for started files; results are indexed by submission order, not completion order. */
  drain(): Promise<(Result | undefined)[]>;
}

/**
 * Results keep the walk's order even though files complete out of order, so the 200-entry cap,
 * `truncated` and the deadline semantics stay those of the sequential walk. Entries are indexed
 * rather than pushed, which is why a dropped or failed file leaves a hole.
 */
export function createFilePool<Result>(limit = FILE_CONCURRENCY): FilePool<Result> {
  const results: (Result | undefined)[] = [];
  const queue: { index: number; work: () => Promise<Result> }[] = [];
  const waiters: (() => void)[] = [];
  let running = 0;
  let stopped = false;
  let failure: { error: unknown } | undefined;
  const halting = new AbortController();

  const settle = () => {
    if (running > 0 || (!stopped && queue.length > 0)) return;
    for (const waiter of waiters.splice(0)) waiter();
  };
  const pump = () => {
    while (!stopped && running < limit && queue.length > 0) {
      const task = queue.shift() as { index: number; work: () => Promise<Result> };
      running++;
      task
        .work()
        .then(
          (value) => {
            results[task.index] = value;
          },
          (error: unknown) => {
            // One rejection must end the search, as rethrowing from the sequential walk did.
            failure ??= { error };
            stopped = true;
            queue.length = 0;
            halting.abort();
          },
        )
        .finally(() => {
          running--;
          pump();
          settle();
        });
    }
    settle();
  };
  const halt = () => {
    stopped = true;
    queue.length = 0;
    halting.abort();
  };

  return {
    get stopped() {
      return stopped;
    },
    get failure() {
      return failure;
    },
    halted: halting.signal,
    submit(work) {
      // The slot is reserved up front so a stopped pool still leaves the ordering intact.
      const index = results.length;
      results.length = index + 1;
      if (stopped) return index;
      queue.push({ index, work });
      pump();
      return index;
    },
    stop() {
      halt();
      settle();
    },
    async drain() {
      if (running > 0 || (!stopped && queue.length > 0))
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          settle();
        });
      return results;
    },
  };
}
