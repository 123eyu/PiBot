import { RpcError } from "@pibot/protocol-base";
import { z } from "zod";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";

/** Raw errors can contain SQL, paths or payloads; only app-owned categories may be logged. */
function evidenceErrorCode(error: unknown): string {
  if (error instanceof RpcError && error.message === "evidence_source_invalid")
    return "evidence_source_invalid";
  if (error instanceof z.ZodError) return "evidence_schema_invalid";
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "ERR_SQLITE_ERROR") return "evidence_storage_failed";
  }
  return "evidence_internal";
}

/** An evidence-storage failure must not cause a completed external action to be retried. */
export function observeDelivery(local: LocalService, context: ToolRunContext, record: () => void) {
  try {
    record();
  } catch (error) {
    local.deps.logger.error(
      JSON.stringify({
        module: "delivery-evidence",
        botId: context.botId,
        runId: context.runId,
        reason: "record_failed",
        errorCode: evidenceErrorCode(error),
      }),
    );
  }
}
