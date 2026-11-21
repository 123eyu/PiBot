import { type FSWatcher, watch } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { matchesFileIdentity, sameFile } from "@pibot/execution/file-identity";
import type { WakePlan } from "@pibot/protocol";

export interface LightWatches {
  verify(signal: AbortSignal): Promise<void>;
  close(): void;
  pollAt: number | null;
}

/** Signals only: the Brain remains the sole owner of snapshots, matching and due work. */
export async function createLightWatches(
  plan: WakePlan,
  signal: AbortSignal,
  changed: () => void,
): Promise<LightWatches> {
  const handles: FSWatcher[] = [];
  const folders = new Map<string, WakePlan["folders"][number]>();
  let closed = false;
  let unhealthy = false;
  let pollAt: number | null = null;
  const close = () => {
    closed = true;
    for (const handle of handles) handle.close();
    signal.removeEventListener("abort", close);
  };
  const check = async (folder: WakePlan["folders"][number], pending: AbortSignal) => {
    pending.throwIfAborted();
    const before = await lstat(folder.path, { bigint: true });
    const canonical = await realpath(folder.path);
    const after = await lstat(folder.path, { bigint: true });
    pending.throwIfAborted();
    if (
      canonical !== folder.path ||
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !matchesFileIdentity(before, { device: folder.dev, inode: folder.ino }) ||
      !sameFile(before, after)
    )
      throw new Error("background_watch_identity_changed");
  };
  const notify = () => {
    if (!closed) changed();
  };
  const verify = async (pending: AbortSignal) => {
    if (closed || unhealthy) throw new Error("background_watch_unavailable");
    for (const folder of folders.values()) await check(folder, pending);
  };
  signal.addEventListener("abort", close, { once: true });
  const registration = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  try {
    for (const folder of plan.folders) {
      signal.throwIfAborted();
      // Recursive supersets are harmless; duplicate triggers share one native handle.
      const previous = folders.get(folder.path);
      if (!previous || folder.recursive) folders.set(folder.path, folder);
    }
    for (const folder of folders.values()) {
      await check(folder, registration);
      try {
        const handle = watch(folder.path, { recursive: folder.recursive }, notify);
        handles.push(handle);
        handle.on("error", () => {
          unhealthy = true;
          notify();
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          !["ENOSPC", "EMFILE", "ENOSYS", "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"].includes(
            code ?? "",
          )
        )
          throw error;
        pollAt = Date.now() + 900_000;
      }
      await check(folder, registration);
    }
    await verify(registration);
    return { verify, close, pollAt };
  } catch (error) {
    close();
    throw error;
  }
}
