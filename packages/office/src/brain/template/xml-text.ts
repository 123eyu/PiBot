import type { Element, XmlPart } from "../ooxml/xml.ts";
import type { TemplateBudget } from "./budget.ts";

/**
 * Small span helpers shared by the three format adapters. Each format keeps its own element names,
 * but they all locate text runs and rebuild them the same way, so the merge rule (a placeholder split
 * across runs is joined first, then replaced with the first run's formatting) is written once.
 */
export function prefixOf(source: string, element: Element) {
  const raw = source.slice(element.start, element.openEnd);
  const name = /^<([^\s/>]+)/u.exec(raw)?.[1] ?? "";
  const index = name.indexOf(":");
  return index === -1 ? "" : name.slice(0, index + 1);
}

export function rawOf(source: string, element: Element) {
  return source.slice(element.start, element.end);
}

/** All elements of one name and namespace below a node, in document order. */
export function find(root: Element, name: string): Element[] {
  const out: Element[] = [];
  const visit = (node: Element) => {
    if (node.name === name) out.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

export function directChild(parent: Element, name: string) {
  return parent.children.find((node) => node.name === name);
}

/** Attribute in a prefixed namespace, e.g. `r:id` on a slide id entry. */
export function attribute(node: Element, name: string, uri: string) {
  for (const [key, value] of node.attrs) {
    const separator = key.indexOf(":");
    if (
      separator !== -1 &&
      key.slice(separator + 1) === name &&
      node.ns.get(key.slice(0, separator)) === uri
    )
      return value;
  }
  return undefined;
}

/**
 * Merged text of a paragraph-like element. `tab` and `breakName` keep their visible effect because a
 * template that spans a tab or line break would otherwise look matched while staying unreadable.
 */
export function mergedText(
  xml: XmlPart,
  container: Element,
  _runName: string,
  textName: string,
  options: { tab?: string; breakName?: string } = {},
) {
  const parts: string[] = [];
  const visit = (node: Element) => {
    if (node.name === textName) {
      parts.push(decodeLeaf(xml, node));
      return;
    }
    if (options.tab && node.name === options.tab) {
      parts.push("\t");
      return;
    }
    if (options.breakName && node.name === options.breakName) {
      parts.push("\n");
      return;
    }
    for (const child of node.children) visit(child);
  };
  for (const child of container.children) visit(child);
  return parts.join("");
}

function decodeLeaf(xml: XmlPart, node: Element) {
  if (node.children.length || node.complexText || node.closeStart === node.end) return "";
  return xml.source
    .slice(node.openEnd, node.closeStart)
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/gu, unescapeOne);
}
function unescapeOne(_whole: string, code: string) {
  if (code === "amp") return "&";
  if (code === "lt") return "<";
  if (code === "gt") return ">";
  if (code === "quot") return '"';
  if (code === "apos") return "'";
  return String.fromCodePoint(
    code.startsWith("#x") ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1)),
  );
}

/**
 * The runs that hold a mergeable paragraph's text. Anything else inside the range (fields, drawings,
 * revision markers) is reported as unsupported instead of being silently dropped.
 */
export function simpleRuns(
  container: Element,
  runName: string,
  allowed: { run: readonly string[]; paragraph: readonly string[] },
) {
  const runs: Element[] = [];
  for (const child of container.children)
    if (child.name === runName) {
      if (!child.children.every((node) => allowed.run.includes(node.name))) return undefined;
      // One visible text node per run keeps "first run formatting" unambiguous.
      if (child.children.filter((node) => node.name !== "rPr").length !== 1) return undefined;
      runs.push(child);
    } else if (!allowed.paragraph.includes(child.name)) return undefined;
  if (!runs.length) return undefined;
  const first = runs[0] as Element;
  const last = runs.at(-1) as Element;
  const between = container.children.filter(
    (node) => node.start >= first.start && node.end <= last.end && !runs.includes(node),
  );
  return between.length ? undefined : { runs, first, last };
}

/** Text run XML for a rebuilt paragraph: line breaks stay explicit, formatting comes from the first run. */
export function runXml(
  prefix: string,
  textName: string,
  text: string,
  props: string,
  budget: TemplateBudget,
  options: { breakName?: string } = {},
) {
  // Line breaks generate whole runs, including a copy of the original formatting.
  let lines = 1;
  for (const _ of text.matchAll(/\n/gu)) lines++;
  budget.expand(lines * 3, lines * (props.length + prefix.length * 6 + textName.length * 2 + 64));
  const run = `${prefix}r`;
  return text
    .split("\n")
    .map((line, index) => {
      const lineBreak = index && options.breakName ? `<${prefix}${options.breakName}/>` : "";
      const body =
        line || index === 0
          ? `<${prefix}${textName} xml:space="preserve">${escapeText(line)}</${prefix}${textName}>`
          : "";
      return `<${run}>${props}${lineBreak}${body}</${run}>`;
    })
    .join("");
}

/**
 * Applies span replacements right to left so earlier offsets stay valid, and rejects overlapping
 * edits: a structural rewrite and an inner text rewrite must not both claim the same bytes.
 */
export function applyEdits(
  source: string,
  edits: readonly { start: number; end: number; value: string }[],
) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  const chunks: string[] = [];
  let limit = source.length;
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end > limit || edit.start > edit.end)
      throw new Error("office_invalid");
    chunks.push(source.slice(edit.end, limit), edit.value);
    limit = edit.start;
  }
  chunks.push(source.slice(0, limit));
  return chunks.reverse().join("");
}

export function escapeText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("\r", "&#13;");
}
