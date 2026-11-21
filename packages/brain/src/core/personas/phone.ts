import type { LocalToolDefinition } from "@pibot/agent";
import type { Bot, CapabilityToolRegistry, ModelInfo } from "@pibot/protocol-base";
import { botSystemPrompt } from "./bot.ts";
import { phonePrompts } from "./prompts/phone.ts";

/**
 * The fixed part of a phone's offline prompt. It follows the Bot's own prompt and never
 * changes between snapshots, so a phone's request prefix stays cacheable.
 */
export function phoneOfflineRule(language: "zh" | "en") {
  return phonePrompts.phoneOfflineRule[language];
}

/**
 * The computer's own prompt for a Bot answering on a phone: the same assembly as a desktop run
 * (persona, norms, capability scope for exactly these tools, memory proposals only), plus the
 * fixed phone rule. The phone sends it as it is and never rebuilds a prompt itself.
 */
export function phoneSystemPrompt(
  bot: Bot,
  language: "zh" | "en",
  model: ModelInfo,
  providerName: string,
  definitions: readonly Pick<LocalToolDefinition, "name">[],
  capabilityTools: CapabilityToolRegistry,
) {
  return [
    botSystemPrompt(
      bot,
      language,
      model,
      providerName,
      // Every phone tool is direct on the phone (no load groups), and memory writes only propose.
      { definitions, memoryMode: "ask", group: false, workplace: false, search: null },
      capabilityTools,
    ),
    phoneOfflineRule(language),
  ].join("\n\n");
}
