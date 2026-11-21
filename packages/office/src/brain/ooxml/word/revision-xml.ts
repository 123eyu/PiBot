import { one } from "../locate.ts";
import { type Element, elements, escapeXml, type XmlPart } from "../xml.ts";
import type { WordDocument } from "./document.ts";

export function inherited(
  d: WordDocument,
  xml: ReturnType<WordDocument["pkg"]["xml"]>,
  node: Element,
  raw = d.raw(xml, node),
) {
  const at = raw.indexOf(">"),
    open = raw.slice(0, at);
  const ns = Array.from(node.ns)
    .filter(([p]) => p !== "xml" && !new RegExp(`\\sxmlns${p ? `:${p}` : ""}=`).test(open))
    .map(([p, u]) => ` xmlns${p ? `:${p}` : ""}="${escapeXml(u)}"`)
    .join("");
  const insert = raw[at - 1] === "/" ? at - 1 : at;
  raw = raw.slice(0, insert) + ns + raw.slice(insert);
  return raw;
}
export function restoreProperties(
  d: WordDocument,
  part: string,
  xml: XmlPart,
  parent: Element,
  change: Element,
) {
  const previous = one(change.children.filter((n) => n.uri === d.uri && n.name === parent.name));
  // The saved base types omit these children; they belong to the current full property type.
  const keep = new Set(
    parent.name === "pPr"
      ? ["rPr", "sectPr"]
      : parent.name === "sectPr"
        ? ["headerReference", "footerReference"]
        : [],
  );
  const changes: Record<string, string> = {};
  for (const child of parent.children)
    if (child.uri === d.uri && !keep.has(child.name)) changes[child.name] = "";
  for (const child of previous.children)
    if (child.uri === d.uri && !keep.has(child.name))
      changes[child.name] = inherited(d, xml, child);
  const value = d.propertyValue(xml, { ...parent, children: [parent] }, parent.name, changes);
  d.replace(part, xml, parent, value);
}

export function unwrapRevision(d: WordDocument, xml: XmlPart, node: Element) {
  let value = xml.source.slice(node.openEnd, node.closeStart);
  for (const child of [...node.children].reverse()) {
    let raw = d.raw(xml, child);
    if (node.name === "del") {
      const edits: { start: number; end: number; value: string }[] = [];
      for (const text of elements(child))
        if (text.uri === d.uri && text.name === "delText") {
          const open = xml.source.slice(text.start, text.openEnd),
            qualified = /^<([^\s/>]+)/u.exec(open)?.[1];
          if (!qualified) throw new Error("office_invalid");
          const name = qualified.replace(/delText$/u, "t");
          edits.push({
            start: text.start,
            end: text.openEnd,
            value: open.replace(`<${qualified}`, `<${name}`),
          });
          if (text.closeStart !== text.end)
            edits.push({
              start: text.closeStart,
              end: text.end,
              value: xml.source
                .slice(text.closeStart, text.end)
                .replace(`</${qualified}`, `</${name}`),
            });
        }
      for (const e of edits.sort((a, b) => b.start - a.start))
        raw = raw.slice(0, e.start - child.start) + e.value + raw.slice(e.end - child.start);
    }
    value =
      value.slice(0, child.start - node.openEnd) +
      inherited(d, xml, child, raw) +
      value.slice(child.end - node.openEnd);
  }
  return value;
}
