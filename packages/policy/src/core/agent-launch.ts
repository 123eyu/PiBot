import type { PermissionsSettings } from "@pibot/protocol-base";
import { createPolicyTrace } from "./explain.ts";
import type { PolicyResult } from "./types.ts";

/**
 * May this Bot start an external coding agent at all? The agent reads, writes
 * and runs commands with its own tools, so a Bot whose command or file-write level is "never"
 * must not get one; otherwise the launch is allowed and each later step the agent asks about
 * is judged on its own. The folder boundary is the sandbox's (writable = the topic's folders).
 */
export function agentLaunchPolicy(settings: PermissionsSettings): PolicyResult {
  const trace = createPolicyTrace();
  const blocked = (["run_command", "write_file"] as const).filter(
    (category) => settings.levels[category] === "never",
  );
  for (const category of ["run_command", "write_file"] as const)
    trace.step(
      "level",
      `agent_launch_${category}`,
      settings.levels[category] === "never" ? "deny" : "info",
      {
        level: settings.levels[category],
      },
    );
  return {
    decision: blocked.length ? "deny" : "allow",
    reason: blocked.length ? "agent_launch_permission_never" : "agent_launch_allowed",
    risk: "normal",
    facts: [],
    canRemember: false,
    explanation: trace.steps,
  };
}
