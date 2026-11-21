import type { Logger } from "@pibot/observability";

export function retireBrain(previous: Electron.UtilityProcess, logger: Logger): Promise<void> {
  return new Promise((resolve, reject) => {
    let forceTimer: ReturnType<typeof setTimeout>;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const exited = () => {
      clearTimeout(forceTimer);
      clearTimeout(deadline);
      resolve();
    };
    previous.once("exit", exited);
    forceTimer = setTimeout(() => {
      logger.warn("brain graceful stop timeout, forcing exit");
      deadline = setTimeout(() => {
        previous.off("exit", exited);
        reject(new Error("Brain exit unconfirmed"));
      }, 3000);
      try {
        if (previous.pid) process.kill(previous.pid, "SIGKILL");
        else previous.kill();
      } catch {
        // ESRCH is not an exit acknowledgement: a new SQLite writer must still wait.
        logger.warn("brain force stop unavailable");
      }
      // OAuth rotation needs its 15s deadline and two 30s cipher RPCs to persist before force.
    }, 90_000);
    try {
      previous.postMessage({ type: "stop" });
    } catch {
      logger.warn("brain stop message unavailable");
    }
  });
}
