import type { ModelInfo } from "@pibot/protocol-base";
import { piPrompts } from "./prompts/pi.ts";

export const piPersonas = {
  zh: piPrompts.piPersonas.zh,
  en: piPrompts.piPersonas.en,
} as const;

function runtimeLabel(value: string, limit: number): string {
  // Custom catalog fields are user input; keep them bounded and on one line.
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(cleaned).slice(0, limit).join("");
}

export function piSystemPrompt(
  language: keyof typeof piPersonas,
  model: ModelInfo,
  providerName: string,
  persona: string = piPersonas[language],
  botName = "Pi",
  capabilities = "",
): string {
  const provider = runtimeLabel(providerName, 80);
  const name = runtimeLabel(model.name, 80);
  const id = runtimeLabel(model.id, 256);
  const runtimeInfo =
    language === "zh"
      ? `你当前运行在 ${provider} 的 ${name}（${id}）上。用户问起你是什么模型时，如实告诉对方；你的名字仍然是 ${runtimeLabel(botName, 200)}。`
      : `You are currently running on ${name} (${id}) from ${provider}. When users ask what model you are, tell them truthfully; your name is still ${runtimeLabel(botName, 200)}.`;
  const vision =
    language === "zh"
      ? model.input.includes("image")
        ? "你可以看到用户发来的图片。"
        : "当前模型不能接收图片；用户想发图时，告诉对方可以在设置里换一个支持图片的模型。"
      : model.input.includes("image")
        ? "You can see images sent by the user."
        : "The current model cannot receive images; tell users who want to send images that they can choose an image-capable model in Settings.";
  // This rule stays stable across turns; the model reads the user's language from the conversation.
  const replyLanguage = piPrompts.replyLanguage[language];
  const userFacingTerms = piPrompts.userFacingTerms[language];
  // Fixed text, so the cached prompt prefix stays the same from turn to turn.
  const progressReplies = piPrompts.progressReplies[language];
  return [
    persona,
    capabilities,
    `${runtimeInfo}\n${vision}`,
    replyLanguage,
    userFacingTerms,
    progressReplies,
  ]
    .filter(Boolean)
    .join("\n\n");
}
