import type { PolicyResult, SecretUsePolicyInput } from "@pibot/policy";
import { secretUsePolicy } from "@pibot/policy";
import type { ToolRunContext } from "../../../core/local-types.ts";
import type { LocalService } from "../../../local-service.ts";
import type { SecretUse } from "../../credentials/port.ts";

/** Command consent and secret consent share a card; remember never persists command authority. */
export function secretCommandPolicy(
  local: LocalService,
  context: ToolRunContext,
  result: PolicyResult,
  uses: SecretUse[],
  yolo: boolean,
  source: SecretUsePolicyInput["source"],
): PolicyResult {
  if (!uses.length || result.decision === "deny") return result;
  // Assignment is enforced for both sources: a secret given only to other Bots refuses the call.
  local.userSecrets.assertUses(uses, context.botId);
  const grants = source === "command" ? local.grants(context.botId, context) : [];
  const granted = uses.every((use) =>
    grants.some(
      (grant) =>
        grant.botId === context.botId &&
        grant.category === "run_command" &&
        grant.scope.kind === "secret" &&
        grant.scope.name === use.name &&
        !grant.revokedAt,
    ),
  );
  return secretUsePolicy(result, {
    source,
    uses,
    granted,
    yolo,
    rememberable: !context.routineRunId && result.risk !== "danger",
  });
}
