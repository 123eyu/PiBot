import { type Bot, type ModelInfo, resolveThinkingLevel } from "@pibot/protocol";

export function normalizedThinking(
  model: Pick<ModelInfo, "reasoning" | "thinkingLevels">,
  thinking: Bot["thinkingLevel"] | null | undefined,
): Bot["thinkingLevel"] {
  return resolveThinkingLevel(model, thinking);
}
