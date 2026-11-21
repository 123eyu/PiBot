/**
 * Shared bounds for automatic continuations and the task tree. Each value is defined once so a
 * capacity change cannot leave two callers disagreeing about the same limit.
 */

/** Automatic continuations one root run may take, across TODO, parent resume and summary. */
export const ROOT_CONTINUATION_LIMIT = 32;

/** Consecutive continuations without progress before the chain stops. */
export const NO_PROGRESS_LIMIT = 2;

/**
 * How often one model response may be continued after hitting the output cap. Two leaves room for
 * a long answer split in three, and still fails a run that cannot finish within three responses.
 */
export const OUTPUT_CONTINUATION_LIMIT = 2;
/**
 * Replies whose stream dropped after visible text, continued in the same reply per run.
 * More drops than this end the run with `network` as before: the connection is not recovering.
 */
export const CONNECTION_CONTINUATION_LIMIT = 3;

/** Rejected continuations one batch may retry before its pending results are dropped. */
export const CONTINUATION_TRIGGER_ATTEMPTS = 3;

/** Continuation roots tracked at once. Distinct from the run queue capacity in run-queue.ts. */
export const CONTINUATION_ROOT_CAPACITY = 128;

/** Statuses in which a task or run still occupies work. */
export const ACTIVE_TASK_STATUSES: ReadonlySet<string> = new Set(["queued", "running", "stopping"]);

/**
 * A user-confirmed release waits longer than an ordinary stop: a session that already refused to
 * stop may still be finishing its own cleanup. Kept here so both release paths agree on the bound.
 */
export const FORCE_RELEASE_TIMEOUT_MS = 30_000;

/**
 * Bound for certifying SDK idle after a rejected abort. The prompt had already drained
 * before that abort ran, so waiting longer only keeps a Bot locked for a request that is gone.
 */
export const DRAIN_CERTIFY_TIMEOUT_MS = 5_000;

/**
 * Exit-path bound. A run whose drain failed keeps a never-settling `finished` by design, so
 * shutdown reports what is left instead of waiting for it forever.
 */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 15_000;

/** Task tree paging: rows per `task_status` page, and the total one tree read may collect. */
export const TASK_TREE_PAGE = 50;
export const TASK_TREE_MAX = 100;
