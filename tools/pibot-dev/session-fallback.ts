/**
 * When a `session/load` may be replaced by a new topic. This is the one decision that can
 * lose a task thread, so it lives alone and is checked against the failure matrix instead of
 * riding along with the general error classification.
 */

/** The app's fixed code for a failure it named, when there is one. */
export const failureCode = (error: unknown) => {
  const code = (error as { data?: { code?: unknown } } | null)?.data?.code;
  return typeof code === "string" ? code : undefined;
};

/**
 * Cancellation covers the whole preparation, so every step checks it before doing work.
 * This sits in this module so the guard can be replayed without spawning the app: it runs before
 * the next request, which is what keeps a cancelled turn from opening a topic or sending a prompt.
 */
export function throwIfCancelled(signal: AbortSignal, cancelled: () => unknown): void {
  if (signal.aborted) throw cancelled();
}

/** Only a session the app no longer knows may be replaced. */
export function sessionLost(error: unknown): boolean {
  const code = failureCode(error);
  // A named refusal is final: busy, permission, quota or cancellation must fail this step and keep
  // the topic id, because a second topic would silently lose the thread's context. Text below this
  // line is never consulted once the app said what happened.
  if (code) return code === "session_not_found";
  // Older apps had no codes at all. Only this error's own exact text can be trusted: `stderr` is
  // shared by every request on the connection, so one stale line there must not start a topic.
  return (error as { message?: unknown } | null)?.message === "Unknown ACP session";
}
