import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type {
  AcpBot,
  AcpDefaultModel,
  AcpModel,
  AcpRuntimePort,
  AcpThinkingLevel,
} from "./types.ts";

/*
 * ACP session config option "model" (category model): which model the session's Bot runs on.
 * Setting it changes that Bot's model in Pi Bot — the same switch as the Bot settings panel, so
 * it shows there and applies to the Bot's other topics too. Maintainers 2026-11-04: the
 * self-iteration workflow keeps 小栈 on its main model and switches to a fallback when the main one
 * keeps failing.
 * Options are the models Pi Bot can run now (configured providers only).
 */

export const MODEL_CONFIG_ID = "model";
/** The session Bot's thinking level (maintainers 2026-11-15: switchable from ACP clients). */
export const THINKING_CONFIG_ID = "thought_level";
/** The app-wide default model, the one Bots without their own model run on (maintainers 2026-11-15). */
export const DEFAULT_MODEL_CONFIG_ID = "default_model";
const THINKING_NAMES: Record<AcpThinkingLevel, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
};
/** Values are matched against the offered list, never parsed: model ids may contain "/". */
const value = (provider: string, id: string) => `${provider}/${id}`;

export async function modelOptions(runtime: AcpRuntimePort, signal: AbortSignal) {
  const [models, providers] = await Promise.all([
    runtime.models(signal),
    runtime.providers(signal),
  ]);
  const names = new Map(providers.map((p) => [p.id, p.name]));
  return models.map((model) => ({
    value: value(model.provider, model.id),
    name: `${names.get(model.provider) ?? model.provider} · ${model.name}`,
    provider: model.provider,
    id: model.id,
    thinkingLevels: model.thinkingLevels ?? (["off"] as AcpThinkingLevel[]),
  }));
}

type Offered = Awaited<ReturnType<typeof modelOptions>>;

/** The levels the Bot's effective model takes: its own model, else the app default. */
function thinkingLevels(bot: AcpBot, options: Offered, defaults?: AcpDefaultModel | null) {
  const provider = bot.modelProvider ?? defaults?.provider;
  const id = bot.modelId ?? defaults?.id;
  return options.find((option) => option.provider === provider && option.id === id)?.thinkingLevels;
}

/** Thinking level and default model, next to the Bot's model option (modelConfig). */
export function extraConfig(
  bot: AcpBot,
  options: Offered,
  defaults: AcpDefaultModel | null | undefined,
  supports: { thinking: boolean; defaultModel: boolean },
): SessionConfigOption[] {
  const extra: SessionConfigOption[] = [];
  const levels = thinkingLevels(bot, options, defaults);
  // A model that only runs without thinking has nothing to choose.
  if (supports.thinking && levels && levels.length > 1) {
    const current =
      bot.thinkingLevel && levels.includes(bot.thinkingLevel) ? bot.thinkingLevel : levels[0];
    extra.push({
      id: THINKING_CONFIG_ID,
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: current as string,
      options: levels.map((level) => ({ value: level, name: THINKING_NAMES[level] })),
    });
  }
  if (supports.defaultModel) {
    const current = defaults ? value(defaults.provider, defaults.id) : "";
    const offered = options.map(({ value, name }) => ({ value, name }));
    if (!options.some((option) => option.value === current))
      offered.unshift({ value: current, name: current || "Not set" });
    extra.push({
      id: DEFAULT_MODEL_CONFIG_ID,
      name: "Pi Bot default model",
      category: "_pibot_default_model",
      type: "select",
      currentValue: current,
      options: offered,
    });
  }
  return extra;
}

/** A level the chosen default model accepts: the current one if it still fits, else the nearest. */
export function defaultThinking(model: Offered[number], current?: AcpThinkingLevel) {
  const levels = model.thinkingLevels;
  if (current && levels.includes(current)) return current;
  return levels.includes("medium") ? "medium" : (levels.at(-1) as AcpThinkingLevel);
}

export function modelConfig(
  bot: AcpBot,
  options: Awaited<ReturnType<typeof modelOptions>>,
): SessionConfigOption[] {
  const current = bot.modelProvider && bot.modelId ? value(bot.modelProvider, bot.modelId) : "";
  const offered = options.map(({ value, name }) => ({ value, name }));
  // A Bot on the app's default model has no own choice; show that instead of a wrong pick.
  if (!options.some((option) => option.value === current))
    offered.unshift({ value: current, name: current ? current : "Pi Bot default" });
  return [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: current,
      options: offered,
    },
  ];
}
