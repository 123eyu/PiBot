// What exec knows about a stdio MCP that did not come up. Exec reports facts only
// (exit, host failure, the sandbox's own refusals, a redacted stderr tail); brain turns them
// into one fixed reason for the person and the log.
import type { SandboxBlockItem } from "../core/types.ts";
import { ExecError } from "../core/types.ts";

/** UI budget for the stderr tail; exec keeps 8 KB, the person sees the end of it. */
export const DIAGNOSIS_STDERR_CHARS = 4 * 1024;

export interface ConnectorServerDiagnosis {
  /** The server process ended by itself, before Pi Bot asked it to stop. */
  exited: boolean;
  exitCode: number | null;
  signal: string | null;
  /** The sandbox host never started the server (SRT setup, payload or spawn of the shell). */
  hostFailed: boolean;
  /** The program itself could not be started (not found, not executable). */
  spawnFailed: boolean;
  /** The server ran outside the sandbox at the person's explicit request. */
  outsideSandbox: boolean;
  /** Redacted when exec has a redactor; brain redacts again before display. */
  stderrTail: string;
  /** The sandbox's own refusals for this server (kernel reports, proxy refusals). */
  denials: SandboxBlockItem[];
}

/** A start failure that carries what exec saw; `reason` stays the stable ExecError reason. */
export class ConnectorStartError extends ExecError {
  constructor(
    reason: ExecError["reason"],
    readonly diagnosis: ConnectorServerDiagnosis,
  ) {
    super("connector_server_unavailable", reason);
    this.name = "ConnectorStartError";
  }
}

/** Waits for a settled exit at most `ms`; a running server is a fact, not an error. */
export function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    void promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
