import type { BinaryToolRun, PreparedTool } from "@pibot/brain/kit";

/**
 * Target-facing fields shared by every office read/write call. Kept in its own module so the
 * conversion executor can build the same context without importing the main executor.
 */
export function officeFileContext(run: BinaryToolRun, item: PreparedTool, signal: AbortSignal) {
  return {
    cwd: item.cwd,
    writeRoots: run.writeRoots(item),
    rootIdentities: item.boundary?.roots,
    denyWriteRoots: item.boundary?.denyWriteRoots,
    expectedPath: item.result.path?.path,
    signal,
  };
}
