import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { LocalService } from "../../local-service.ts";
import type { DeliveryEvidenceService } from "./delivery-evidence-service.ts";
import type { ReviewExecutionService } from "./review-execution-service.ts";

export function registerAgentReviewRpc(
  handle: KernelRegisterRpc,
  local: LocalService,
  reviews: ReviewExecutionService,
  evidence: DeliveryEvidenceService,
) {
  const signal = () => AbortSignal.any([local.shutdown.signal, AbortSignal.timeout(20_000)]);
  handle("reviewExecutions.list", ({ botId, conversationId, ...page }) =>
    reviews.list({ botId, conversationId }, page, signal()),
  );
  handle("reviewExecutions.get", ({ botId, conversationId, id }) =>
    reviews.get({ botId, conversationId }, id, signal()),
  );
  handle("reviewExecutions.findings", ({ botId, conversationId, id }) =>
    reviews.findings({ botId, conversationId }, id, signal()),
  );
  handle("deliveryEvidence.list", ({ botId, conversationId, ...page }) =>
    evidence.list({ botId, conversationId }, page, signal()),
  );
  handle("deliveryEvidence.get", ({ botId, conversationId, id }) =>
    evidence.get({ botId, conversationId }, id, signal()),
  );
}
