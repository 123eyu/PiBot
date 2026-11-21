import type { ReactNode } from "react";

export function mentionParts(text: string, names: readonly string[]) {
  const alternatives = [...new Set(names)]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!alternatives.length) return [{ text, mention: false }];
  const pattern = new RegExp(
    `(^|[\\s([{，。；：,;:])(@(?:${alternatives.join("|")}))(?=$|[\\s\\p{P}])`,
    "gu",
  );
  const parts: { text: string; mention: boolean }[] = [];
  let before = 0;
  for (const match of text.matchAll(pattern)) {
    const offset = match.index + (match[1]?.length ?? 0);
    parts.push(
      { text: text.slice(before, offset), mention: false },
      { text: match[2] ?? "", mention: true },
    );
    before = offset + (match[2]?.length ?? 0);
  }
  parts.push({ text: text.slice(before), mention: false });
  return parts;
}
export function mentionText(text: string, names: readonly string[], className: string): ReactNode {
  let offset = 0;
  return mentionParts(text, names).map((part) => {
    const start = offset;
    offset += part.text.length;
    return part.mention ? (
      <span key={start} className={className}>
        {part.text}
      </span>
    ) : (
      part.text
    );
  });
}
interface Node {
  type: string;
  value?: string;
  children?: Node[];
  data?: { hName: string; hProperties: { className: string } };
}
export function remarkMentions(names: readonly string[], className: string) {
  return () => (tree: Node) => {
    const walk = (node: Node) => {
      if (
        !node.children ||
        node.type === "link" ||
        node.type === "code" ||
        node.type === "inlineCode"
      )
        return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) {
          walk(child);
          return [child];
        }
        return mentionParts(child.value, names).map((part) =>
          part.mention
            ? {
                type: "emphasis",
                children: [{ type: "text", value: part.text }],
                data: { hName: "span", hProperties: { className } },
              }
            : { type: "text", value: part.text },
        );
      });
    };
    walk(tree);
  };
}
