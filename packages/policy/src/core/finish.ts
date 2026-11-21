import { matchesGrant } from "../grants/grants.ts";
import { containsPath } from "../paths/paths.ts";
import { publicReadDomain } from "../targets/web.ts";
import type { PolicyTrace } from "./explain.ts";
import { serviceDecision } from "./finish-service-decisions.ts";
import { finishShared } from "./finish-shared.ts";
import { privateCommandDecision } from "./private-command.ts";
import type { RequestFacts } from "./request-facts.ts";
import type { EvaluationInput, PolicyOptions } from "./types.ts";

export function finish(
  input: EvaluationInput,
  options: PolicyOptions,
  prepared: RequestFacts,
  trace: PolicyTrace,
) {
  return privateCommandDecision(
    input,
    finishShared(input, options, prepared, trace, {
      matchesGrant,
      containsPath,
      publicReadDomain,
      serviceDecision,
    }),
    trace,
  );
}
