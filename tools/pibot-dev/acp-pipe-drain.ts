import type { ChildProcess } from "node:child_process";

/** Closing our bridge is bounded. This certifies the pipe only, never the brain's dispatched run. */
export async function drainAcpPipe(child: ChildProcess, closed: Promise<unknown>) {
  let done = false;
  const term = setTimeout(() => {
    if (!done) child.kill("SIGTERM");
  }, 10_000);
  const kill = setTimeout(() => {
    if (!done) child.kill("SIGKILL");
  }, 12_000);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const drained = await Promise.race([
      closed.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), 15_000);
      }),
    ]);
    if (!drained) {
      // Keep the dispatch marker, but do not let an unconfirmed bridge's handles strand the CLI.
      // Detaching local handles is not evidence that the bridge or brain run has stopped.
      child.unref();
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    return drained;
  } finally {
    done = true;
    clearTimeout(term);
    clearTimeout(kill);
    clearTimeout(timeout);
  }
}
