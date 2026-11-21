import type { BackgroundJob } from "@pibot/execution";

/** Observe the existing bounded target view, including older/remote targets without push output. */
export async function waitForBackgroundOutput(
  job: Pick<BackgroundJob, "running" | "output" | "outputLines">,
  seconds: number,
  signal: AbortSignal,
  subscribe: (changed: () => void) => () => void,
  ended: () => boolean = () => !job.running,
  /** Ignore new output: return only when the command ends or the deadline passes. */
  untilEnd = false,
) {
  signal.throwIfAborted();
  if (ended()) return;
  const output = job.output(20_000);
  const lines = job.outputLines;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(deadline);
      clearInterval(poll);
      signal.removeEventListener("abort", cancel);
      off();
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const cancel = () => {
      cleanup();
      reject(signal.reason);
    };
    const check = () => {
      try {
        if (ended() || (!untilEnd && (job.outputLines !== lines || job.output(20_000) !== output)))
          finish();
      } catch (error) {
        // Timer callbacks must return adapter failures to the tool's common error wrapper.
        cleanup();
        reject(error);
      }
    };
    const deadline = setTimeout(finish, seconds * 1000);
    const poll = setInterval(check, 250);
    const off = subscribe(check);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    else check();
  });
  signal.throwIfAborted();
}
