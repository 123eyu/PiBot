import { RunnerPolicyPreparationSchema, RunnerPreparedFactsSchema } from "@pibot/protocol-base";
import { createPolicyTrace } from "../core/explain.ts";
import { finishShared } from "../core/finish-shared.ts";
import type { EvaluationInput, PolicyResult } from "../core/types.ts";

/** No grants, group exceptions, host services or sandbox escape exist in an offline private turn. */
export function decideRunnerPortable(
  raw: unknown,
  facts: unknown,
  signal: AbortSignal,
): PolicyResult {
  signal.throwIfAborted();
  const { context, request } = RunnerPolicyPreparationSchema.parse(raw);
  const prepared = RunnerPreparedFactsSchema.parse(facts);
  const input: EvaluationInput = {
    botId: context.botId,
    request,
    settings: context.settings,
    botOverrides: context.overrides,
    workplace: context.workplace,
    boundary: context.boundary,
    cwd: request.cwd,
    signal,
  };
  const unavailable = (): never => {
    throw new Error("offline_policy_branch_unavailable");
  };
  const trace = createPolicyTrace(prepared.result.explanation);
  const result = finishShared(
    input,
    {
      platform: context.boundary.location?.platform ?? "linux",
      userHome: context.workplace.home,
    },
    prepared,
    trace,
    {
      // These adapters are unreachable with the strictly limited input above. Refuse a future
      // expansion until it supplies the same real platform adapter, rather than guessing a path.
      matchesGrant: unavailable,
      containsPath: unavailable,
      publicReadDomain: unavailable,
      serviceDecision: () => undefined,
    },
  );
  result.canRemember = false;
  delete result.grantScope;
  if (
    result.decision !== "deny" &&
    (request.category === "run_command" || request.category === "write_file")
  ) {
    result.decision = "ask";
    result.reason = "phone_runner_confirmation";
    return trace.result(result, "boundary");
  }
  return result;
}
