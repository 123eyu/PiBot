import type { TranscriptContext } from "@earendil-works/pi-ai";
import { AgentError } from "../core/errors.ts";
import { contextBudget } from "../runtime/context-budget.ts";
import { historyTokens, messageTokens } from "../runtime/context-estimate.ts";
import { shortenToolText } from "./tool-result-trim.ts";

type Message = TranscriptContext["messages"][number];
/** Last-resort request projection; originals, tool arguments and signed reasoning remain intact. */
export function fitRequest(messages: Message[], window: number, scale = 1) {
  const limit = contextBudget(window).inputLimit;
  let tokens = Math.ceil(historyTokens(messages) * scale);
  if (tokens <= limit) return { messages, tokens };
  const fitted = messages.slice();
  for (let i = 0; i < fitted.length && tokens > limit; i++) {
    const message = fitted[i];
    if (message?.role !== "toolResult" || message.toolName.startsWith("memory_")) continue;
    const next = {
      ...message,
      content: message.content.map((part) =>
        part.type === "text" ? { ...part, text: shortenToolText(part.text) } : part,
      ),
    };
    fitted[i] = next;
    tokens -= Math.floor((messageTokens(message) - messageTokens(next)) * scale);
  }
  if (tokens > limit) throw new AgentError("context_too_large");
  return { messages: fitted, tokens };
}
