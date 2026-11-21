// Supervisor for the shared macOS `log stream` (violation-monitor.ts). If the brain
// dies without dispose (crash, SIGKILL), a directly spawned `log` would live on until its next
// write hit the closed pipe. This process holds a pipe from the brain on stdin that the brain
// never writes: EOF there means the brain is gone, so `log` is stopped (SIGTERM, then SIGKILL)
// and reaped. The stream's arguments are fixed here, never taken from the parent.
//
// A separate entry (desktop `violation-log`, runner bundle) so it loads nothing but Node; it runs
// from source under plain Node in development: keep to erasable TypeScript syntax.
import { spawn } from "node:child_process";

const KILL_AFTER_MS = 2000;

const log = spawn(
  "/usr/bin/log",
  ["stream", "--predicate", 'processID == 0 AND eventMessage ENDSWITH "_SBX"', "--style", "ndjson"],
  // Its stdout is this process's stdout: the pipe the brain reads.
  { env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" }, stdio: ["ignore", "inherit", "ignore"] },
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  log.kill("SIGTERM");
  setTimeout(() => {
    log.kill("SIGKILL");
    process.exit(0);
  }, KILL_AFTER_MS).unref();
}
log.once("exit", () => process.exit(0));
log.once("error", () => process.exit(1));
process.stdin.resume();
process.stdin.once("end", stop);
process.stdin.once("close", stop);
process.stdin.once("error", stop);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, stop);
