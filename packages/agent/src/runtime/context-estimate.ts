import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent/context-helpers";
import type { PromptContext } from "../core/types.ts";

type Message = ContextEvent["messages"][number];
// The SDK chars/4 fallback undercounts Chinese. This estimate reads content only, never opaque
// signatures, usage receipts or JSONL metadata. Provider usage remains a separate lower bound.
export function textTokens(text: string) {
  let nonAscii = 0;
  for (const point of text) if ((point.codePointAt(0) ?? 0) > 127) nonAscii += point.length;
  return Math.ceil((text.length - nonAscii) / 4 + nonAscii);
}
export function messageTokens(message: Message) {
  let correction = 0;
  const add = (text: string) => {
    correction += textTokens(text) - Math.ceil(text.length / 4);
  };
  if (message.role === "compactionSummary" || message.role === "branchSummary")
    add(message.summary);
  else if ("content" in message) {
    if (typeof message.content === "string") add(message.content);
    else
      for (const part of message.content) {
        if (part.type === "text") add(part.text);
        if (part.type === "thinking") add(part.thinking);
        if (part.type === "toolCall") add(JSON.stringify(part.arguments));
      }
  }
  if (message.role === "system") {
    for (const section of Object.values(message.sections ?? {})) if (section) add(section);
    if (message.toolsAdded) add(JSON.stringify(message.toolsAdded));
  }
  return estimateTokens(message) + Math.max(0, correction) + 8;
}
export function historyTokens(messages: Message[], visible?: ReadonlySet<string>) {
  return messages.reduce(
    (total, message) =>
      total +
      messageTokens(
        visible && message.role === "system" && message.toolsAdded
          ? { ...message, toolsAdded: message.toolsAdded.filter((tool) => visible.has(tool.name)) }
          : message,
      ),
    0,
  );
}
/** Current live sections are not checkpoint content and must still have request headroom. */
export function referenceTokens(context: PromptContext | undefined, cap: number) {
  if (!context) return 0;
  const { group, ...sections } = context;
  const system = Object.values(sections).reduce((sum, value) => sum + textTokens(value ?? ""), 0);
  const groupText = group
    ? textTokens(
        [
          group.information,
          ...(group.parts ?? []).map((p) => p.text),
          ...group.messages.map((m) => m.text),
        ].join("\n"),
      )
    : 0;
  return system + Math.min(groupText, cap) + Math.min(5, group?.images?.length ?? 0) * 1200;
}
