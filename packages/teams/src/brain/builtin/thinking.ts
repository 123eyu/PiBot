import { type Bot, type ModelInfo, resolveThinkingLevel } from "@pibot/protocol";

/** A default model chooses the provider, while an explicit role chooses the thinking budget. */
export function roleThinking(requested: Bot["thinkingLevel"] | undefined, model: ModelInfo | null) {
  return model ? resolveThinkingLevel(model, requested) : ("off" as const);
}
