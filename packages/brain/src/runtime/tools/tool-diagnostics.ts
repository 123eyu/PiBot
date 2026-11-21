import { diagnosticCode } from "@pibot/protocol-base";
import { DiagnosticsRepo } from "@pibot/storage";
import type { State } from "./local-run/local-run-shared.ts";
import type { LocalRunOperations } from "./local-run.ts";

/** Never derive diagnostics by parsing a model-visible text result or exception message. */
export function logToolResult(run: LocalRunOperations, state: State, status: string) {
  const { local, context } = run;
  const details = state.result?.details;
  const errorCode =
    status === "done"
      ? null
      : (diagnosticCode(
          (status === "error" ? details?.executionCheck : undefined) ??
            details?.errorCode ??
            state.inputFailure?.code ??
            state.auditFacts?.reasonCode,
        ) ??
        (status === "aborted"
          ? "cancelled"
          : status === "blocked"
            ? "policy_denied"
            : "tool_failed"));
  const metadata = {
    errorCode,
    resultCount: details?.resultCount ?? null,
    connectorId: state.prepared?.connector?.connector.id ?? null,
  };
  try {
    new DiagnosticsRepo(local.deps.db).tool(state.recordId, metadata);
  } catch {
    // Diagnostics cannot turn a completed external action into a failure that invites replay.
    local.deps.logger.warn(
      JSON.stringify({
        module: "diagnostics",
        event: "metadata_write_failed",
        runId: context.runId,
      }),
    );
  }
  const performance = state.timing.finish();
  local.deps.logger.info(
    JSON.stringify({
      module: "tool",
      event: "result",
      runId: context.runId,
      tool: state.call.tool,
      status,
      ok: status === "done",
      ...metadata,
      durationMs: performance.durationMs,
      // A total alone could not tell a slow browser capture from an approval card the user
      // left open or a takeover wait; the phase split is numbers only.
      phases: performance.phases,
    }),
  );
}
