import { abortable } from "../../core/abort.ts";
import type { ChatRun } from "./chat-run.ts";

/**
 * Abort the agent session and wait for the run to end. Callers decide what a failure means: a
 * session that will not stop leaves the Bot busy, so this never swallows the error or the timeout.
 */
export async function stopSession(
  run: Pick<ChatRun, "session" | "aborting" | "finished">,
  ms = 5_000,
): Promise<void> {
  if (run.session) {
    run.aborting ??= run.session.abort();
    await abortable(run.aborting, AbortSignal.timeout(ms));
  }
  await abortable(run.finished, AbortSignal.timeout(ms));
}
