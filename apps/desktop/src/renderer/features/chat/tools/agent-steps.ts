import { agentTurnFacts } from "@pibot/external-agents-contract";
import { createContext, useContext } from "react";

/**
 * An external agent's steps are Pi Bot step records without Pi Bot's command logs. Their
 * output, when the agent reports one, lives in the turn reply's `usage.externalAgent.stepDetails`,
 * which can sit on a later bubble than the step; the history hands the conversation's outputs
 * down so each step row finds its own, and says plainly when the agent reported none.
 */
export interface AgentStepDetail {
  /** The command or path it ran on. */
  input?: string;
  output?: string;
}
export interface AgentSteps {
  /** Set in an agent Bot's chat: every step there is the agent's. */
  agentName?: string;
  details: ReadonlyMap<string, AgentStepDetail>;
}
export const AgentStepsContext = createContext<AgentSteps>({ details: new Map() });
export const useAgentSteps = () => useContext(AgentStepsContext);

const cache = new WeakMap<readonly unknown[], ReadonlyMap<string, AgentStepDetail>>();
/** Built once per message list (the history re-renders often; the list identity rarely changes). */
export function agentStepDetails(
  messages: readonly { usage: unknown; role: string }[],
): ReadonlyMap<string, AgentStepDetail> {
  const known = cache.get(messages);
  if (known) return known;
  const details = new Map<string, AgentStepDetail>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const detail of agentTurnFacts(message.usage)?.stepDetails ?? [])
      details.set(detail.toolCallId, {
        ...(detail.input ? { input: detail.input } : {}),
        ...(detail.output ? { output: detail.output } : {}),
      });
  }
  cache.set(messages, details);
  return details;
}
