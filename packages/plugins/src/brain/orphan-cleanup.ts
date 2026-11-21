import { lstat, opendir, rm } from "node:fs/promises";
import { join } from "node:path";
import { IdSchema } from "@pibot/plugins-contract/full";

const ORPHAN_GRACE_MS = 10 * 60_000;
const ORPHAN_BATCH_ENTRIES = 200;
const ORPHAN_BATCH_BUDGET_MS = 2_000;

export interface OrphanPluginCleanupResult {
  removedStages: number;
  removedInstallations: number;
  failures: number;
  completed: boolean;
}

function missing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

async function oldDirectory(path: string, now: number): Promise<boolean> {
  const stat = await lstat(path);
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    now - Math.max(stat.mtimeMs, stat.ctimeMs) >= ORPHAN_GRACE_MS
  );
}

function aborted(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError");
}

async function nextBatch(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  signal.throwIfAborted();
}

/**
 * Materialization precedes the database transaction, so a hard process exit can strand private
 * directories. Only generated UUID/stage names under Pi Bot's managed plugin root are considered;
 * unknown entries and live database installations are never touched.
 */
export async function cleanupOrphanPluginDirectories(
  dataDir: string,
  hasInstallation: (installationId: string) => boolean,
  signal: AbortSignal,
  now = Date.now(),
): Promise<OrphanPluginCleanupResult> {
  const result: OrphanPluginCleanupResult = {
    removedStages: 0,
    removedInstallations: 0,
    failures: 0,
    completed: false,
  };
  const root = join(dataDir, "plugins");
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    signal.throwIfAborted();
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      result.failures += 1;
      result.completed = true;
      return result;
    }
    directory = await opendir(root);
    while (true) {
      signal.throwIfAborted();
      const batchStarted = performance.now();
      let entryCount = 0;
      while (
        entryCount < ORPHAN_BATCH_ENTRIES &&
        performance.now() - batchStarted < ORPHAN_BATCH_BUDGET_MS
      ) {
        signal.throwIfAborted();
        const entry = await directory.read();
        if (!entry) {
          result.completed = true;
          return result;
        }
        signal.throwIfAborted();
        entryCount += 1;
        const stageId = entry.name.startsWith(".stage-")
          ? IdSchema.safeParse(entry.name.slice(7))
          : undefined;
        const installation = IdSchema.safeParse(entry.name);
        if (!stageId?.success && !installation.success) continue;
        if (installation.success && hasInstallation(installation.data)) continue;
        const path = join(root, entry.name);
        try {
          if (!(await oldDirectory(path, now))) continue;
          signal.throwIfAborted();
          await rm(path, { recursive: true, force: true });
          if (stageId?.success) result.removedStages += 1;
          else result.removedInstallations += 1;
        } catch (error) {
          if (aborted(error, signal)) return result;
          if (!missing(error)) result.failures += 1;
        }
      }
      await nextBatch(signal);
    }
  } catch (error) {
    if (!aborted(error, signal) && !missing(error)) result.failures += 1;
    else if (missing(error)) result.completed = true;
    return result;
  } finally {
    try {
      await directory?.close();
    } catch (error) {
      if (
        !aborted(error, signal) &&
        !missing(error) &&
        (!error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "ERR_DIR_CLOSED")
      )
        result.failures += 1;
    }
  }
}
