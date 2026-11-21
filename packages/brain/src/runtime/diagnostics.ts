import { DiagnosticsSnapshotSchema } from "@pibot/protocol-base";
import { DiagnosticsRepo } from "@pibot/storage";
import type { KernelRegisterRpc } from "../core/business-rpc.ts";
import type { LocalService } from "../local-service.ts";

export function registerDiagnosticsRpc(handle: KernelRegisterRpc, local: LocalService) {
  handle("diagnostics.snapshot", async (_, { signal }) => {
    signal.throwIfAborted();
    const snapshot = new DiagnosticsRepo(local.deps.db).snapshot();
    // Read only Pi Bot's own permission view; do not enumerate apps, contacts or calendars.
    if (local.deps.host.computer) {
      try {
        const status = await local.deps.host.computer.call(
          "host.computer.status",
          {},
          AbortSignal.any([signal, AbortSignal.timeout(3000)]),
        );
        for (const name of ["accessibility", "screenRecording"] as const) {
          const state = status.permissions[name];
          snapshot.permissions[name] = {
            state:
              state === "granted" || state === "denied" || state === "not_needed"
                ? state
                : "unknown",
            nativeStatus: null,
            observedAt: new Date().toISOString(),
          };
        }
      } catch {
        signal.throwIfAborted();
        // Export remains useful with an unavailable host; unknown is never a denial or grant.
      }
    }
    return DiagnosticsSnapshotSchema.parse(snapshot);
  });
}

export function logRunFinished(local: LocalService, runId: string) {
  try {
    const result = new DiagnosticsRepo(local.deps.db).finishRun(runId);
    if (result)
      local.deps.logger.info(JSON.stringify({ module: "run", event: "finished", ...result }));
  } catch {
    local.deps.logger.warn(
      JSON.stringify({ module: "diagnostics", event: "run_metadata_failed", runId }),
    );
  }
}
