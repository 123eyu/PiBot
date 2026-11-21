import type { Deliverable } from "@pibot/protocol-base";

/** Preserve the original four-check engine's format-specific section matching. */
export function missingDeliverySections(
  text: string,
  deliverable: Deliverable,
  kind: Exclude<Deliverable["kind"], "any">,
) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const headings: string[] = [];
  let fence = false;
  lines.forEach((raw, line) => {
    const value = kind === "docx" ? raw.trim().replace(/^#{1,6}\s+/, "") : raw.trim();
    if (kind === "md") {
      if (/^(```|~~~)/.test(value)) fence = !fence;
      const match = fence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(value);
      if (match?.[2]) headings.push(match[2]);
      return;
    }
    if (kind === "xlsx") {
      const sheet = /^\[(.+)\]$/.exec(value);
      if (sheet?.[1] && (line === 0 || !lines[line - 1]?.trim())) headings.push(sheet[1]);
      return;
    }
    if (kind === "pptx") {
      const slide = /^\[Slide \d+\]\s*(.*)$/.exec(value);
      if (slide) {
        if (slide[1]) headings.push(slide[1]);
        return;
      }
    }
    if (value && Array.from(value).length <= 40) headings.push(value);
  });
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/^[\s#>*_-]*(?:\d+[.)、]|[一二三四五六七八九十]+[、.])?\s*/u, "")
      .replace(/[\s\p{P}\p{S}]+/gu, "");
  const normalized = headings.map(normalize);
  return (deliverable.sections ?? []).filter((section) => {
    const wanted = normalize(section);
    return !wanted || !normalized.some((heading) => heading.includes(wanted));
  });
}
