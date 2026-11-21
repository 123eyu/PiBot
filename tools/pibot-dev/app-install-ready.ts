import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { MacArtifact } from "./app-artifact.ts";

async function boundedText(path: string, limit: number, tail = false) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || (!tail && before.size > limit)) return "";
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (current.dev !== before.dev || current.ino !== before.ino) return "";
    const buffer = Buffer.alloc(Math.min(limit, current.size));
    const offset = tail ? Math.max(0, current.size - buffer.length) : 0;
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return offset ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

/** Fixed lifecycle metadata only. A GUI marker alone cannot attest the matching owner build. */
export async function installedReady(
  data: string,
  artifact: MacArtifact,
  since: string,
  pids: readonly number[],
  now = Date.now(),
) {
  try {
    const started = Date.parse(since);
    // The caller waits at most 90 seconds; a clock jump spanning multiple days is not evidence.
    if (
      !Number.isFinite(started) ||
      !Number.isFinite(now) ||
      now < started ||
      now - started > 180_000
    )
      return false;
    const descriptor = JSON.parse(
      await boundedText(join(data, "background-runtime", "owner.json"), 4096),
    ) as {
      pid?: unknown;
      version?: unknown;
      utilityPid?: unknown;
    };
    if (
      typeof artifact.runtimeVersion !== "string" ||
      !artifact.runtimeVersion.startsWith(`${artifact.version}:`) ||
      !/^[a-f0-9]{64}$/.test(artifact.runtimeVersion.slice(artifact.version.length + 1)) ||
      descriptor.version !== artifact.runtimeVersion ||
      typeof descriptor.pid !== "number" ||
      !pids.includes(descriptor.pid) ||
      (descriptor.utilityPid !== null &&
        (typeof descriptor.utilityPid !== "number" || !pids.includes(descriptor.utilityPid))) ||
      (await lstat(join(data, "background-runtime", "owner.json"))).mtimeMs < started
    )
      return false;
    const days = new Set([
      new Date(started).toISOString().slice(0, 10),
      new Date(now).toISOString().slice(0, 10),
    ]);
    for (const day of days) {
      let logs: string;
      try {
        logs = await boundedText(join(data, "gui-logs", `${day}.log`), 1 << 20, true);
      } catch (error) {
        // A midnight launch need not create yesterday's log. Other read failures stay unknown.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (
        logs.split("\n").some((line) => {
          try {
            const row = JSON.parse(line) as {
              timestamp?: unknown;
              message?: unknown;
              event?: unknown;
            };
            if (typeof row.timestamp !== "string") return false;
            const timestamp = Date.parse(row.timestamp);
            if (
              !Number.isFinite(timestamp) ||
              timestamp < started ||
              timestamp > now ||
              new Date(timestamp).toISOString().slice(0, 10) !== day
            )
              return false;
            if (row.event === "gui_first_screen_ready") return true;
            if (typeof row.message !== "string") return false;
            const message = JSON.parse(row.message) as { event?: unknown };
            return message.event === "gui_first_screen_ready";
          } catch {
            return false;
          }
        })
      )
        return true;
    }
    return false;
  } catch {
    return false;
  }
}
