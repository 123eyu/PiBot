import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Redactor } from "@pibot/secrets";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LoggerOptions {
  dir: string;
  redactor: Pick<Redactor, "redact">;
  /** Entrypoints explicitly opt into console output; libraries never inspect the environment. */
  dev?: boolean;
}

const dayMs = 24 * 60 * 60 * 1000;

function prune(dir: string, date: string): void {
  const oldest = new Date(Date.parse(date) - 13 * dayMs).toISOString().slice(0, 10);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const match = /^(\d{4}-\d{2}-\d{2})\.log$/.exec(entry.name);
    const fileDate = match?.[1];
    if (!entry.isFile() || !fileDate) continue;
    const parsed = new Date(fileDate);
    // Only our valid daily files are owned by retention, never unrelated export artifacts.
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== fileDate) continue;
    if (fileDate < oldest) {
      try {
        unlinkSync(join(dir, entry.name));
      } catch (error) {
        // Main and brain share retention: the other process may already have removed this file.
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  }
}

export function createLogger({ dir, redactor, dev }: LoggerOptions): Logger {
  const consoleEnabled = dev ?? false;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let retainedDate = new Date().toISOString().slice(0, 10);
  prune(dir, retainedDate);

  function write(level: keyof Logger, message: string): void {
    const timestamp = new Date().toISOString();
    const date = timestamp.slice(0, 10);
    // Redact before JSON encoding so quotes, backslashes and tabs cannot hide known secrets.
    const line = JSON.stringify({ timestamp, level, message: redactor.redact(message) });
    try {
      if (date !== retainedDate) {
        retainedDate = date;
        prune(dir, date);
      }
      append(date, line);
    } catch (error) {
      // A log write runs inside error paths and event handlers; throwing here turns a missing or
      // full log directory into an uncaught exception that kills the process. Report only the
      // failure code, never the line, and keep running.
      reportFailure(error);
    }
    if (consoleEnabled) console[level](line);
  }

  function append(date: string, line: string): void {
    const file = join(dir, `${date}.log`);
    // Synchronous append gives callers immediate persistence without a shutdown flush race.
    try {
      appendFileSync(file, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      // The directory was removed underneath a running process (cleanup, data reset); recreate once.
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(file, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    }
  }

  let failureReported = false;
  function reportFailure(error: unknown): void {
    if (failureReported) return;
    failureReported = true;
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown";
    process.stderr.write(`pibot log write failed (${code}); further failures are suppressed\n`);
  }

  return {
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
  };
}
