import { explainPolicyResult } from "../core/explain.ts";
import type { PolicyResult } from "../core/types.ts";

export interface SecretUsePolicyInput {
  /**
   * `command`: the Bot injects the secrets into a command it wrote. `connector_config`: the
   * connection's own configuration (headers, env, URL) references them.
   */
  source: "command" | "connector_config";
  uses: Array<{ name: string; revision: number }>;
  /** Every use is covered by a live per-secret grant of this Bot. */
  granted: boolean;
  yolo: boolean;
  /** Remembering secrets is offered only outside routines and never for a dangerous call. */
  rememberable: boolean;
}

/**
 * The caller has already checked each secret's assignment ("who can use") for this Bot; a secret
 * assigned to other Bots never reaches this decision.
 *
 * Maintainers 2026-11-01: a Bot the connection's access rule admits may use the secrets that
 * connection's own configuration references. The connection was configured by the user with
 * those secrets, so a second per-secret card asked the same question again. Only a command that
 * injects a secret directly keeps the per-secret grant.
 */
export function secretUsePolicy(result: PolicyResult, input: SecretUsePolicyInput): PolicyResult {
  if (!input.uses.length || result.decision === "deny") return result;
  if (input.source === "connector_config")
    return explainPolicyResult(result, "secret", "secret_connector_config", "info");
  return explainPolicyResult(
    {
      ...result,
      secretUses: input.uses,
      decision: !input.granted && !input.yolo ? "ask" : result.decision,
      canRemember: false,
      canRememberSecrets: input.rememberable,
      // No programs grant may survive into a combined secret approval.
      grantScope: undefined,
    },
    "secret",
    input.granted ? "secret_grant_matched" : input.yolo ? "secret_yolo" : "secret_grant_required",
  );
}
