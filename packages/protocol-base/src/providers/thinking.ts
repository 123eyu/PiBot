import type { ModelInfo } from "./providers.ts";

export type ThinkingLevel = "off" | "low" | "medium" | "high";
const order: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];

/** Keep the requested preference separate: an incapable model must not erase it. */
export function resolveThinkingLevel(
  model: Pick<ModelInfo, "reasoning" | "thinkingLevels">,
  requested: ThinkingLevel | null | undefined = "medium",
): ThinkingLevel {
  if (!model.reasoning) return "off";
  const target = requested ?? "medium";
  const levels = model.thinkingLevels ?? order;
  let nearest: ThinkingLevel | undefined;
  for (const level of order) {
    if (!levels.includes(level)) continue;
    if (
      nearest === undefined ||
      Math.abs(order.indexOf(level) - order.indexOf(target)) <
        Math.abs(order.indexOf(nearest) - order.indexOf(target))
    )
      nearest = level;
  }
  return nearest ?? "off";
}
