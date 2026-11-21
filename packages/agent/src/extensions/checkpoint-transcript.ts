import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { AgentError } from "../core/errors.ts";
import { shortenToolText } from "./tool-result-trim.ts";

type Message = SessionBeforeCompactEvent["preparation"]["messagesToSummarize"][number];
function contentText(content: string | { type: string; text?: string }[]) {
  return typeof content === "string"
    ? content
    : content.map((p) => (p.type === "text" ? (p.text ?? "") : "[image omitted]")).join("\n");
}
function redactArguments(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactArguments(item, redact));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key), redactArguments(item, redact)]),
    );
  return value;
}

// Only a request copy is changed. Signed history and authorized tool arguments stay untouched.
export function summaryTranscript(
  messages: Message[],
  redact: (text: string) => string,
  shorten = false,
) {
  const lines: string[] = [];
  const calls = new Map<string, string>();
  const results = new Set<string>();
  const bounded = (text: string) => (shorten ? shortenToolText(redact(text)) : redact(text));
  for (const message of messages) {
    if (message.role === "user") lines.push(`[user] ${redact(contentText(message.content))}`);
    else if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "text") lines.push(`[assistant] ${redact(part.text)}`);
        if (part.type !== "toolCall") continue;
        if (calls.has(part.id)) throw new AgentError("compaction_failed");
        calls.set(part.id, part.name);
        if (!part.name.startsWith("memory_")) {
          const parameters = redactArguments(part.arguments, redact);
          lines.push(`[call ${part.id} ${part.name}] ${bounded(JSON.stringify(parameters))}`);
        }
      }
    } else if (message.role === "toolResult") {
      const name = calls.get(message.toolCallId);
      if (!name || results.has(message.toolCallId)) throw new AgentError("compaction_failed");
      results.add(message.toolCallId);
      if (!name.startsWith("memory_"))
        lines.push(
          `[result ${message.toolCallId} ${name}] ${message.isError ? "[error] " : ""}${bounded(contentText(message.content))}`,
        );
    } else if (message.role === "compactionSummary")
      lines.push(`[checkpoint] ${bounded(message.summary)}`);
  }
  for (const [id, name] of calls)
    if (!results.has(id) && !name.startsWith("memory_"))
      lines.push(`[result ${id} ${name}] [未记录结果 / result not recorded; outcome unknown]`);
  return redact(lines.join("\n\n"));
}

/** End offsets let a partial checkpoint retain every unprocessed source message. */
export function transcriptGroups(messages: Message[], redact: (text: string) => string) {
  const groups: { text: string; end: number }[] = [];
  const pending = new Set<string>();
  let start = 0;
  summaryTranscript(messages, redact, true);
  const flush = (end: number) => {
    const text = summaryTranscript(messages.slice(start, end), redact, true);
    groups.push({ text, end });
    start = end;
  };
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    // A new user/assistant entry ends an interrupted group with missing-result placeholders.
    if (i > start && (!pending.size || message?.role === "user" || message?.role === "assistant")) {
      flush(i);
      pending.clear();
    }
    if (message?.role === "assistant")
      for (const part of message.content) if (part.type === "toolCall") pending.add(part.id);
    if (message?.role === "toolResult") pending.delete(message.toolCallId);
  }
  if (start < messages.length) flush(messages.length);
  return groups;
}
export function transcriptUnits(messages: Message[], redact: (text: string) => string) {
  return transcriptGroups(messages, redact).map((group) => group.text);
}
