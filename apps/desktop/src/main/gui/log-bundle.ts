import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type DiagnosticsSnapshot, DiagnosticsSnapshotSchema } from "@pibot/protocol";
import { createZip, type ZipEntry } from "../host/zip.ts";
import { readLogTail } from "./log-tail.ts";

export interface DiagnosticEnvironment {
  app: { version: string; commit: string | null };
  system: {
    platform: string;
    version: string;
    architecture: string;
    language: string;
    timeZone: string;
    utcOffsetMinutes: number;
  };
}

/** Daily application logs only: never follow a link into a session, attachment or arbitrary file. */
export async function collectLogs(logsDir: string, prefix = "logs", signal?: AbortSignal) {
  const names = (
    await readdir(logsDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    })
  )
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .sort()
    .slice(-14);
  const entries: ZipEntry[] = [];
  for (const name of names) {
    signal?.throwIfAborted();
    const file = await open(
      join(logsDir, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error("invalid_log_file");
      entries.push({
        name: `${prefix}/${name}`,
        data: await readLogTail(file, info.size, signal),
        modified: info.mtime,
      });
    } finally {
      await file.close();
    }
  }
  return entries;
}

/** The snapshot is schema-checked here even on the authenticated owner channel. */
export async function collectLogBundle(options: {
  logsDir: string;
  additionalDirs: readonly { name: string; path: string }[];
  environment: DiagnosticEnvironment;
  snapshot(signal: AbortSignal): Promise<unknown>;
  signal: AbortSignal;
}) {
  let snapshot: DiagnosticsSnapshot;
  let snapshotStatus: "available" | "unavailable" = "available";
  try {
    snapshot = DiagnosticsSnapshotSchema.parse(await options.snapshot(options.signal));
  } catch {
    options.signal.throwIfAborted();
    snapshotStatus = "unavailable";
    const unknown = { state: "unknown", nativeStatus: null, observedAt: null };
    snapshot = DiagnosticsSnapshotSchema.parse({
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      connections: [],
      connectionsTruncated: false,
      permissions: {
        accessibility: unknown,
        screenRecording: unknown,
        contacts: unknown,
        calendar: unknown,
      },
      runs: [],
      tools: [],
    });
  }
  const logs = [];
  for (const dir of [{ name: "logs", path: options.logsDir }, ...options.additionalDirs])
    logs.push(...(await collectLogs(dir.path, dir.name, options.signal)));
  options.signal.throwIfAborted();
  const diagnostics = {
    ...snapshot,
    snapshotStatus,
    ...options.environment,
    logTimeFormat: "UTC ISO-8601",
    logTailLimitBytes: 4 * 1024 * 1024,
  };
  return createZip([
    ...logs,
    {
      name: "diagnostics.json",
      data: Buffer.from(JSON.stringify(diagnostics, null, 2)),
      modified: new Date(),
    },
  ]);
}
