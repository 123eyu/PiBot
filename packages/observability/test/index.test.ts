import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRedactor } from "@pibot/secrets";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/index.ts";

let dir: string;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T12:34:56.789Z"));
  vi.stubEnv("NODE_ENV", "test");
  dir = mkdtempSync(join(tmpdir(), "pibot-log-test-"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function read(date: string): string {
  return readFileSync(join(dir, `${date}.log`), "utf8");
}

describe("createLogger", () => {
  it("creates nested directories and immediately appends every level as UTC JSON lines", () => {
    const nested = join(dir, "data", "logs");
    const logger = createLogger({ dir: nested, redactor: createRedactor() });
    logger.info("started");
    logger.warn("warning");
    logger.error("failed");
    const lines = readFileSync(join(nested, "2026-10-09.log"), "utf8").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { timestamp: "2026-10-09T12:34:56.789Z", level: "info", message: "started" },
      { timestamp: "2026-10-09T12:34:56.789Z", level: "warn", message: "warning" },
      { timestamp: "2026-10-09T12:34:56.789Z", level: "error", message: "failed" },
    ]);
  });

  it("redacts every message before encoding, including secrets with JSON escapes", () => {
    const redactor = createRedactor();
    const secret = 'private-"key\\with\ttab';
    redactor.add(secret);
    const formatKey = `sk-ant-api03-${"a".repeat(35)}`;
    const logger = createLogger({ dir, redactor });
    for (const level of ["info", "warn", "error"] as const) {
      logger[level](`${secret} ${formatKey}`);
    }
    const content = read("2026-10-09");
    expect(content).not.toContain(secret);
    expect(content).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(content).not.toContain(formatKey);
    expect(
      content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).message),
    ).toEqual(["[REDACTED] [REDACTED]", "[REDACTED] [REDACTED]", "[REDACTED] [REDACTED]"]);
  });

  it("uses registrations added after the logger was created", () => {
    const redactor = createRedactor();
    const logger = createLogger({ dir, redactor });
    redactor.add("new-private-key");
    logger.info("new-private-key");
    expect(JSON.parse(read("2026-10-09")).message).toBe("[REDACTED]");
  });

  it("encodes multiline messages as one physical line", () => {
    createLogger({ dir, redactor: createRedactor() }).info("first\nsecond\r\nthird");
    expect(read("2026-10-09").split("\n")).toHaveLength(2);
    expect(JSON.parse(read("2026-10-09")).message).toBe("first\nsecond\r\nthird");
  });

  it("fails closed when redaction throws without writing or echoing plaintext", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger({
      dir,
      dev: true,
      redactor: {
        redact: () => {
          throw new Error("Redaction failed");
        },
      },
    });
    expect(() => logger.error("private-value")).toThrow("Redaction failed");
    expect(readdirSync(dir)).toEqual([]);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("mirrors redacted lines to the matching console method in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    const spies = {
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
    const redactor = createRedactor();
    redactor.add("private-value");
    const logger = createLogger({ dir, redactor, dev: true });
    for (const level of ["info", "warn", "error"] as const) {
      logger[level]("private-value");
      expect(spies[level]).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({ timestamp: "2026-10-09T12:34:56.789Z", level, message: "[REDACTED]" }),
      );
    }
  });

  it("stays silent in production and allows the host to override development detection", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    createLogger({ dir, redactor: createRedactor() }).info("production");
    expect(spy).not.toHaveBeenCalled();
    createLogger({ dir, redactor: createRedactor(), dev: true }).info("host dev");
    expect(spy).toHaveBeenCalledTimes(1);
    vi.stubEnv("NODE_ENV", "development");
    createLogger({ dir, redactor: createRedactor(), dev: false }).info("host production");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // Diagnostic logs only (audit lives in the store): a failed write must not crash the process.
  it("survives filesystem failures instead of throwing from a log call", () => {
    mkdirSync(join(dir, "2026-10-09.log"));
    const logger = createLogger({ dir, redactor: createRedactor() });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(() => logger.info("entry")).not.toThrow();
    stderr.mockRestore();
  });
});

describe("UTC rotation and retention", () => {
  it("rotates at UTC midnight even when the supplied local date is still the previous day", () => {
    vi.setSystemTime(new Date("2026-10-09T19:59:59.999-04:00"));
    const logger = createLogger({ dir, redactor: createRedactor() });
    logger.info("before");
    vi.setSystemTime(new Date("2026-10-09T20:00:00.000-04:00"));
    logger.info("after");
    expect(JSON.parse(read("2026-10-09")).timestamp).toBe("2026-10-09T23:59:59.999Z");
    expect(JSON.parse(read("2026-10-10")).timestamp).toBe("2026-10-10T00:00:00.000Z");
  });

  it("prunes on startup by UTC filename, keeping today and the previous 13 dates", () => {
    for (const date of ["2026-09-24", "2026-09-25", "2026-09-26", "2026-10-09"]) {
      writeFileSync(join(dir, `${date}.log`), "existing\n");
    }
    createLogger({ dir, redactor: createRedactor() });
    expect(readdirSync(dir).sort()).toEqual(["2026-09-26.log", "2026-10-09.log"]);
  });

  it("retains exactly 14 UTC daily files during a long-lived logger across month and year boundaries", () => {
    vi.setSystemTime(new Date("2026-12-20T23:59:59.000Z"));
    const logger = createLogger({ dir, redactor: createRedactor() });
    for (let day = 0; day < 25; day++) {
      vi.setSystemTime(new Date(Date.UTC(2026, 11, 20 + day, 23, 59, 59)));
      logger.info(`day ${day}`);
    }
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(14);
    expect(files[0]).toBe("2026-12-31.log");
    expect(files.at(-1)).toBe("2027-01-13.log");
  });

  it("prunes after idle days and preserves unrelated files, invalid dates and directories", () => {
    const preserved = [
      "README.txt",
      "archive.log",
      "2026-02-30.log",
      "2026-99-99.log",
      "2099-01-01.log",
    ];
    for (const name of preserved) writeFileSync(join(dir, name), "keep");
    mkdirSync(join(dir, "2020-01-01.log"));
    const logger = createLogger({ dir, redactor: createRedactor() });
    logger.info("old");
    vi.setSystemTime(new Date("2026-11-01T00:00:00.000Z"));
    logger.info("new");
    expect(readdirSync(dir).sort()).toEqual(
      [...preserved, "2020-01-01.log", "2026-11-01.log"].sort(),
    );
  });

  it("appends to existing files across logger recreation", () => {
    createLogger({ dir, redactor: createRedactor() }).info("one");
    createLogger({ dir, redactor: createRedactor() }).info("two");
    expect(
      read("2026-10-09")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).message),
    ).toEqual(["one", "two"]);
  });
});
