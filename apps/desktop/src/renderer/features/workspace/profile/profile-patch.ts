import type { Bot, MethodParams, ModelInfo } from "@pibot/protocol";

import { normalizedThinking } from "@pibot/renderer-kit";

export { normalizedThinking } from "@pibot/renderer-kit";

// Unrelated edits must not revalidate an unchanged model whose provider may have been removed.
export function profilePatch(
  base: Bot,
  draft: Bot,
  models: ModelInfo[],
): MethodParams["bots.update"] {
  const modelChanged = draft.modelProvider !== base.modelProvider || draft.modelId !== base.modelId;
  const thinkingChanged = draft.thinkingLevel !== base.thinkingLevel;
  const model = models.find((m) => m.provider === draft.modelProvider && m.id === draft.modelId);
  return {
    botId: base.id,
    ...(draft.imageMode !== base.imageMode ? { imageMode: draft.imageMode } : {}),
    ...(draft.name.trim() !== base.name ? { name: draft.name.trim() } : {}),
    ...((draft.description ?? "") !== (base.description ?? "")
      ? { description: draft.description ?? "" }
      : {}),
    ...(draft.systemPrompt !== base.systemPrompt ? { systemPrompt: draft.systemPrompt } : {}),
    ...(draft.avatarShape !== base.avatarShape ? { avatarShape: draft.avatarShape } : {}),
    ...(draft.avatarColor !== base.avatarColor ? { avatarColor: draft.avatarColor } : {}),
    ...(draft.avatarEyes !== base.avatarEyes ? { avatarEyes: draft.avatarEyes } : {}),
    ...(modelChanged ? { modelProvider: draft.modelProvider, modelId: draft.modelId } : {}),
    ...(thinkingChanged
      ? {
          thinkingLevel: model
            ? normalizedThinking(model, draft.thinkingLevel)
            : draft.thinkingLevel,
        }
      : {}),
  };
}
