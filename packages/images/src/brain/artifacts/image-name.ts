import type { AgentRuntime } from "@pibot/agent";
import { abortable, fallbackPersona } from "@pibot/brain/kit";
import type { Logger } from "@pibot/observability";

export async function imageBotName(input: {
  agent: AgentRuntime;
  description: string;
  language: "zh" | "en";
  signal: AbortSignal;
  preferences: ({ provider: string; id: string } | null | undefined)[];
  credentials(provider: string): Promise<void>;
  logger: Logger;
}) {
  const fallback =
    Array.from(input.description.replace(/[\p{C}]/gu, " ").trim())
      .slice(0, 24)
      .join("") || fallbackPersona(input.description, input.language).name;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]);
  try {
    const available = await abortable(input.agent.listModels({ availableOnly: true }), signal);
    // Only explicitly configured text preferences may name an image Bot, never its paid image model.
    const model = input.preferences
      .flatMap((selected) =>
        selected
          ? available.filter(
              (model) => model.provider === selected.provider && model.id === selected.id,
            )
          : [],
      )
      .at(0);
    if (!model) return fallback;
    await abortable(input.credentials(model.provider), signal);
    const persona = await input.agent.generatePersona({
      description: input.description,
      language: input.language,
      model,
      signal,
    });
    signal.throwIfAborted();
    return persona.name;
  } catch {
    input.signal.throwIfAborted();
    input.logger.warn("Image Bot naming unavailable; using description fallback");
    return fallback;
  }
}
