import { messageBubbleText } from "@pibot/client-core";
import type { Summary, useT } from "@pibot/renderer-kit";

// Error texts are full guidance sentences; a sidebar row only has room for the first one.
export function firstSentence(text: string): string {
  const end = text.search(/[。！？]|[.!?](\s|$)/);
  return end < 0 ? text : text.slice(0, end);
}

// Previews need readable text while the full message retains its Markdown formatting.
export function messagePreview(markdown: string): string {
  const text = markdown
    .replace(/^\s*(`{3,}|~{3,})[^\n]*$/gm, "")
    .replace(/!?\[([^\]\n]*)\]\([^\n]*?\)/g, "$1")
    .replace(/`+([^`]+)`+/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*{1,3}|~~)(\S(?:[^\n]*?\S)?)\1/g, "$2")
    // Underscores inside identifiers are literal, not emphasis delimiters.
    .replace(/(?<![\p{L}\p{N}_])(_{1,3})(\S(?:[^\n]*?\S)?)\1(?![\p{L}\p{N}_])/gu, "$2")
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(text);
  return characters.length > 120 ? `${characters.slice(0, 119).join("")}…` : text;
}
/** Only typed program records are localized; a user's or model's bilingual prose stays intact. */
export function summaryPreview(summary: Summary, t: ReturnType<typeof useT>): string {
  const source = summary.previewSource;
  if (!source) return summary.preview;
  if (source.systemEvent)
    return t(
      source.systemEvent === "background_finished"
        ? "background.finished"
        : "background.systemEvent",
    );
  return messageBubbleText({ ...source, content: summary.preview, usage: null }, t);
}
