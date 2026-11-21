/**
 * CommonMark does not close `**` that follows punctuation when a letter comes right after it, so
 * Chinese replies such as 「**核心结论：**后面」 showed the asterisks (video dry run 2026-11-20).
 * The parser leaves those pairs as literal text; this turns the ones next to CJK text into bold.
 * Code and links are left alone, and a pair is only taken inside a single text node.
 */
interface Node {
  type: string;
  value?: string;
  children?: Node[];
}
const CJK = /[　-〿㐀-鿿＀-￯]/u;
const PAIR = /\*\*(?=\S)([^*\n]*?\S)\*\*/gu;

function split(value: string): Node[] | undefined {
  const nodes: Node[] = [];
  let before = 0;
  for (const match of value.matchAll(PAIR)) {
    const inner = match[1] ?? "";
    const next = value[match.index + match[0].length] ?? "";
    if (!CJK.test(inner) && !CJK.test(next)) continue;
    if (match.index > before) nodes.push({ type: "text", value: value.slice(before, match.index) });
    nodes.push({ type: "strong", children: [{ type: "text", value: inner }] });
    before = match.index + match[0].length;
  }
  if (!nodes.length) return undefined;
  if (before < value.length) nodes.push({ type: "text", value: value.slice(before) });
  return nodes;
}

/**
 * Windows acceptance 2026-11-20: in 「**结论：**正文…还有**注意，**这句」 CommonMark pairs the 2nd
 * and 3rd markers into bold 「正文…还有」 and leaves the outer two as text. A plain-text bold run
 * whose neighbours hold stray CJK-side markers goes back to its source text, so the pairs above
 * can be matched again.
 */
function unpair(children: Node[]): Node[] {
  const textOf = (node: Node | undefined) => (node?.type === "text" ? (node.value ?? "") : "");
  const out: Node[] = [];
  for (const [index, child] of children.entries()) {
    const before = /\*\*([^*]*)$/u.exec(textOf(children[index - 1]))?.[1];
    const after = /^([^*]*)\*\*/u.exec(textOf(children[index + 1]))?.[1];
    const simple =
      child.type === "strong" &&
      !!child.children?.length &&
      child.children.every((item) => item.type === "text");
    if (
      simple &&
      ((before !== undefined && CJK.test(before)) || (after !== undefined && CJK.test(after)))
    ) {
      const inner = child.children?.map((item) => item.value ?? "").join("") ?? "";
      out.push({ type: "text", value: `**${inner}**` });
    } else out.push(child);
  }
  // Adjacent text nodes merge so a pair split across them is one string again.
  return out.reduce<Node[]>((merged, node) => {
    const last = merged.at(-1);
    if (last?.type === "text" && node.type === "text")
      last.value = `${last.value ?? ""}${node.value ?? ""}`;
    else merged.push(node.type === "text" ? { ...node } : node);
    return merged;
  }, []);
}

export function remarkCjkStrong() {
  return (tree: Node) => {
    const walk = (node: Node) => {
      if (!node.children || node.type === "link" || node.type === "code") return;
      if (node.children.some((child) => child.type === "text" && child.value?.includes("**")))
        node.children = unpair(node.children);
      node.children = node.children.flatMap((child) => {
        if (child.type === "text" && child.value?.includes("**"))
          return split(child.value) ?? [child];
        walk(child);
        return [child];
      });
    };
    walk(tree);
  };
}
