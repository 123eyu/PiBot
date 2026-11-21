import type { Logger } from "@pibot/observability";
import type { CodeMapRepo, WorkplacesRepo } from "@pibot/storage";

/**
 * Deleting a Bot drops its `working_folders` rows, so the paths have to be read before
 * that transaction and handed over after it commits. The index is derived data — a failed cleanup
 * must not fail the deletion — and a path any record still references (hidden ones included:
 * topics and routines still use them) keeps its rows.
 */
export function forgetUnusedCodeMapPaths(
  repos: { codeMap: CodeMapRepo; workplaces: WorkplacesRepo },
  logger: Logger,
  paths: readonly string[],
): number {
  let dropped = 0;
  for (const path of paths) {
    try {
      if (!repos.workplaces.referencedAt(path)) dropped += repos.codeMap.forgetPath(path);
    } catch (error) {
      // The index rebuilds on next use; only the reason is worth a log line.
      logger.warn(
        `codemap.cleanup_failed reason=${error instanceof Error ? error.name : typeof error}`,
      );
    }
  }
  return dropped;
}
