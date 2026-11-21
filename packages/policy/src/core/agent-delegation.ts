import { deny } from "./deny.ts";
import type { PolicyTrace } from "./explain.ts";
import { effectiveLevel } from "./levels.ts";
import type { EvaluationInput, PolicyResult } from "./types.ts";

/**
 * A Bot hands one piece of work to an external agent Bot. The Bot's own "hand work to
 * external agents" level decides (never / ask / always). A Bot that may never run commands or
 * write files cannot get them done by an agent either: the agent does exactly those things, so a
 * hand-off would widen what the person allowed this Bot. What the agent then does is judged
 * again under the agent Bot's own permissions (launch and every request it makes).
 */
export function agentDelegationPolicy(input: EvaluationInput, trace: PolicyTrace): PolicyResult {
  const request = input.request;
  const result: PolicyResult = {
    decision: "ask",
    reason: "permission_ask",
    risk: "normal",
    category: "agent_delegation",
    facts:
      request.category === "agent_delegation" && request.agent
        ? [{ kind: "program", value: request.agent }]
        : [],
    canRemember: false,
    explanation: [],
  };
  for (const category of ["run_command", "write_file"] as const) {
    const level = effectiveLevel(input.settings.levels[category], input.botOverrides?.[category]);
    trace.step("level", `agent_delegation_${category}`, level === "never" ? "deny" : "info", {
      level,
    });
    if (level === "never") return deny(result, "agent_delegation_bot_never", trace, "level");
  }
  const level = effectiveLevel(
    input.settings.levels.agent_delegation,
    input.botOverrides?.agent_delegation,
  );
  trace.step("level", "permission_level", "info", {
    level,
    source:
      input.permissionSources?.agent_delegation ??
      (input.botOverrides?.agent_delegation === undefined ? "default" : "bot"),
  });
  if (level === "never") return deny(result, "permission_never", trace, "level");
  if (level === "always") {
    result.decision = "allow";
    result.reason = "permission_always";
  }
  return trace.result(result, "level");
}
