import type { RunnerLogger } from "./logger.ts";

/** Exit status for a crash the runner could not handle; distinct from a refused start (1, 78). */
export const RUNNER_FATAL_EXIT = 70;

// Library names only: the stack's file paths include the user's install folder.
const MODULES = [
  "ws",
  "undici",
  "multicast-dns",
  "@pibot/link",
  "@pibot/runner",
  "@pibot/execution",
];
const FIXED_CODE = /^[A-Za-z][A-Za-z0-9_]{1,63}$/;

/** Class, code and the library it came from — never the message, which may carry addresses. */
export function fatalFields(error: unknown) {
  const value = error instanceof Error ? error : undefined;
  const code = value && "code" in value ? String(value.code) : undefined;
  const stack = value?.stack ?? "";
  const source = MODULES.find(
    (name) =>
      stack.includes(`node_modules/${name}/`) ||
      stack.includes(`node_modules\\${name.replace("/", "\\")}\\`),
  );
  return {
    errorClass: value && FIXED_CODE.test(value.name) ? value.name : typeof error,
    ...(code && FIXED_CODE.test(code) ? { code } : {}),
    ...(source ? { source } : {}),
  };
}

export interface RunnerLifecycle {
  stage: "starting" | "running" | "stopping";
  connection?: () => string;
}

/**
 * The Windows runner runs hidden under wscript, so stderr goes nowhere: a crash used to leave
 * no line at all, and `runner status` only said the state was stale (2026-11-11). Write the
 * cause to the runner's own log file first, then end the process as Node would have.
 */
export function installFatalHandlers(logger: RunnerLogger, lifecycle: RunnerLifecycle) {
  const stage = () =>
    lifecycle.stage === "running" && lifecycle.connection
      ? lifecycle.connection()
      : lifecycle.stage;
  const fatal = (origin: "uncaught_exception" | "unhandled_rejection", error: unknown) => {
    try {
      logger.write("error", "runner.fatal", { origin, stage: stage(), ...fatalFields(error) });
    } finally {
      process.exitCode = RUNNER_FATAL_EXIT;
      process.exit(RUNNER_FATAL_EXIT);
    }
  };
  process.on("uncaughtException", (error) => fatal("uncaught_exception", error));
  process.on("unhandledRejection", (reason) => fatal("unhandled_rejection", reason));
}
