import { setTimeout as delay } from "node:timers/promises";
import { connectBackground } from "./background-connection.ts";
import { readDescriptor } from "./background-directory.ts";
import { processAlive, waitBackgroundExit } from "./background-exit.ts";
import { ownerStopping } from "./background-stop.ts";
import type { WindowsBackgroundSecurity } from "./windows-background-security.ts";

// The packaging host supplies the observed GUI PIDs and expected installed build fingerprint.
// This guard performs no backup or replacement; those may start only after it resolves.
export async function drainBackgroundForUpgrade(options: {
  dataDir: string;
  expectedVersion: string;
  guiPids: readonly number[];
  windows?: WindowsBackgroundSecurity;
  signal?: AbortSignal;
  phase?(phase: "upgrade_connected" | "upgrade_stop_requested"): void;
}) {
  const signal = options.signal ?? AbortSignal.timeout(100_000);
  const descriptor = await readDescriptor(options.dataDir, options.windows, signal);
  const connection = await connectBackground(
    options.dataDir,
    options.expectedVersion,
    () => {},
    () => {},
    signal,
    options.windows,
  );
  try {
    options.phase?.("upgrade_connected");
    if (connection.descriptor.instance !== descriptor.instance)
      throw new Error("background_upgrade_owner_changed");
    try {
      await connection.control({ type: "stop-service" }, signal);
    } catch (error) {
      if (signal.aborted || !ownerStopping(error)) throw error;
      // The authenticated predecessor closed its control lane. Still require proof of exit.
    }
    options.phase?.("upgrade_stop_requested");
    await waitBackgroundExit(options.dataDir, descriptor.pid, signal);
    const guiSignal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    for (const pid of options.guiPids) {
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
        throw new Error("background_upgrade_invalid_pid");
      while (processAlive(pid)) await delay(100, undefined, { signal: guiSignal });
    }
  } finally {
    connection.close();
  }
}
