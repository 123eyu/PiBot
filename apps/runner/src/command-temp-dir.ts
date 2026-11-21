import { createHash } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Command temp folders used to sit in `<dataDir>/execution/tmp`, inside the runner's data
 * directory. The sandbox keeps the data directory out of its writable roots, so every command that
 * needed a temp file failed with a read-only mount. The OS temp dir is where the desktop keeps its
 * command temp root and is outside that boundary.
 *
 * The name is derived from the data directory rather than the process id: a crashed predecessor
 * leaves its private `pibot-run-*` folders behind and this start must be able to find and remove
 * them, while two runners with different data directories keep separate folders. The runner lock
 * admits one process per data directory, so removing the folder at startup cannot delete a live
 * runner's folders.
 */
export async function prepareRunnerCommandTempDir(
  dataDir: string,
): Promise<{ path: string; dispose: () => Promise<void> }> {
  const identity = createHash("sha256")
    .update(await realpath(dataDir))
    .digest("hex")
    .slice(0, 16);
  const path = join(tmpdir(), `pibot-runner-${identity}`);
  // Remove first: fs.rm unlinks a planted symlink instead of following it, and a leftover folder
  // from a crashed run may still hold files that make commands fail differently.
  await rm(path, { recursive: true, force: true });
  // Not recursive on purpose: the parent already exists, and a failure to create the folder
  // ourselves (a leftover that could not be removed, or a path that is not a directory) must
  // fail startup instead of running commands in someone else's folder.
  await mkdir(path, { mode: 0o700 });
  return { path, dispose: () => rm(path, { recursive: true, force: true }) };
}
