import type { ReactNode } from "react";
import styles from "./sidebar.module.css";

const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// Search hits should read as prose; the chat view keeps the original Markdown.
export function searchText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/!?\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/^[#>\s*-]+/gmu, "")
    .replace(/[`*_~]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

const SNIPPET_LENGTH = 120;
// Small lead so the hit still lands on the first visible line of the clamped preview.
const SNIPPET_LEAD = 16;

/** A window around the first hit so the user can see why the message matched. */
export function searchSnippet(text: string, query: string): string {
  if (text.length <= SNIPPET_LENGTH) return text;
  const hit = query ? text.search(new RegExp(escapePattern(query), "iu")) : -1;
  let end = Math.min(text.length, Math.max(0, hit - SNIPPET_LEAD) + SNIPPET_LENGTH);
  let start = Math.max(0, end - SNIPPET_LENGTH);
  // Never cut through a surrogate pair, or the edge would render as a replacement glyph.
  const code = (index: number) => text.charCodeAt(index);
  if (start > 0 && code(start) >= 0xdc00 && code(start) <= 0xdfff) start--;
  if (end < text.length && code(end - 1) >= 0xd800 && code(end - 1) <= 0xdbff) end++;
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** Marks every case-insensitive hit with React elements; the text is never parsed as HTML. */
export function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  if (!query) return text;
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(new RegExp(escapePattern(query), "giu"))) {
    if (match.index > offset) parts.push(text.slice(offset, match.index));
    parts.push(
      <mark key={match.index} className={styles.match}>
        {match[0]}
      </mark>,
    );
    offset = match.index + match[0].length;
  }
  if (!parts.length) return text;
  if (offset < text.length) parts.push(text.slice(offset));
  return parts;
}
