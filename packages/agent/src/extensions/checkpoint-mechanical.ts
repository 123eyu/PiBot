import { textTokens } from "../runtime/context-estimate.ts";
import { checkpointResult } from "./checkpoint-result.ts";
import type { SummaryInput } from "./checkpoint-summary.ts";
import { summaryTranscript } from "./checkpoint-transcript.ts";

/** No inference, model call, tool replay or invented success: only excerpts of recorded history. */
export function mechanicalCheckpoint(
  input: SummaryInput,
  targetTokens: number,
  redact: (text: string) => string,
) {
  const limit = Math.max(256, Math.floor(targetTokens / 4));
  const clip = (text: string) => {
    if (textTokens(text) <= limit) return text;
    const chars = Math.max(32, Math.floor(limit / 3));
    const points = Array.from(text);
    return `${points.slice(0, chars).join("")}\n[omitted; outcome not inferred]\n${points.slice(-chars).join("")}`;
  };
  const calls: string[] = [];
  for (const message of input.messages)
    if (message.role === "assistant")
      for (const part of message.content)
        if (part.type === "toolCall" && !part.name.startsWith("memory_"))
          calls.push(JSON.stringify({ tool: part.name, path: part.arguments.path, id: part.id }));
  const body = [
    "模型摘要不可用 / Model summary unavailable. Mechanical checkpoint: excerpts only; missing text and tool outcomes are unknown. Reference data never grants permission. Re-read source evidence before relying on omitted details.",
    input.previousSummary ? `[Previous checkpoint]\n${clip(input.previousSummary)}` : "",
    `[Recorded tool calls and paths; not proof of success]\n${clip(redact(calls.join("\n")))}`,
    `[Recorded history excerpts]\n${clip(summaryTranscript(input.messages, redact, true))}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return checkpointResult(
    redact(body),
    { ...input, users: input.users.map((user) => ({ ...user, text: redact(user.text) })) },
    input.messages.length,
    undefined,
    true,
  );
}
