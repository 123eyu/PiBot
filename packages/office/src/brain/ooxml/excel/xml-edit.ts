import type { Element, XmlPart } from "../xml.ts";
import { escapeXml } from "../xml.ts";

export const SS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
export const order = [
  "sheetPr",
  "dimension",
  "sheetViews",
  "sheetFormatPr",
  "cols",
  "sheetData",
  "sheetCalcPr",
  "sheetProtection",
  "protectedRanges",
  "scenarios",
  "autoFilter",
  "sortState",
  "dataConsolidate",
  "customSheetViews",
  "mergeCells",
  "phoneticPr",
  "conditionalFormatting",
  "dataValidations",
  "hyperlinks",
  "printOptions",
  "pageMargins",
  "pageSetup",
  "headerFooter",
  "rowBreaks",
  "colBreaks",
  "customProperties",
  "cellWatches",
  "ignoredErrors",
  "smartTags",
  "drawing",
  "legacyDrawing",
  "legacyDrawingHF",
  "drawingHF",
  "picture",
  "oleObjects",
  "controls",
  "webPublishItems",
  "tableParts",
  "extLst",
];
export const styleOrder = [
  "numFmts",
  "fonts",
  "fills",
  "borders",
  "cellStyleXfs",
  "cellXfs",
  "cellStyles",
  "dxfs",
  "tableStyles",
  "colors",
  "extLst",
];
export const bookOrder = [
  "fileVersion",
  "fileSharing",
  "workbookPr",
  "workbookProtection",
  "bookViews",
  "sheets",
  "functionGroups",
  "externalReferences",
  "definedNames",
  "calcPr",
  "oleSize",
  "customWorkbookViews",
  "pivotCaches",
  "smartTagPr",
  "smartTagTypes",
  "webPublishing",
  "fileRecoveryPr",
  "webPublishObjects",
  "extLst",
];
export function children(node: Element, name: string) {
  return node.children.filter((n) => n.uri === node.uri && n.name === name);
}
export function unique(node: Element, name: string) {
  const nodes = children(node, name);
  if (nodes.length > 1) throw new Error("office_target_ambiguous");
  return nodes[0];
}
export function raw(xml: XmlPart, node: Element) {
  return xml.source.slice(node.start, node.end);
}
export function attrs(values: Record<string, string | number | boolean | undefined>) {
  return Object.entries(values)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXml(typeof v === "boolean" ? (v ? "1" : "0") : String(v))}"`)
    .join("");
}
export function tag(
  name: string,
  body = "",
  values: Record<string, string | number | boolean | undefined> = {},
) {
  return `<${name}${attrs(values)}>${body}</${name}>`;
}
export function ss(
  name: string,
  body: string,
  values: Record<string, string | number | boolean | undefined> = {},
  uri = SS,
) {
  return tag(name, body, { xmlns: uri, ...values });
}
export function replace(xml: XmlPart, node: Element, value: string) {
  return xml.source.slice(0, node.start) + value + xml.source.slice(node.end);
}
export function withAttrs(
  xml: XmlPart,
  node: Element,
  updates: Record<string, string | number | boolean | undefined>,
  body?: string,
) {
  const values: Record<string, string | number | boolean | undefined> = Object.fromEntries(
    node.attrs,
  );
  Object.assign(values, updates);
  const name = /^<([^\s/>]+)/u.exec(xml.source.slice(node.start, node.openEnd))?.[1];
  if (!name) throw new Error("office_invalid_xml");
  return tag(
    name,
    body ?? (node.closeStart === node.end ? "" : xml.source.slice(node.openEnd, node.closeStart)),
    values,
  );
}
export function insert(xml: XmlPart, parent: Element, value: string, offset = parent.closeStart) {
  if (parent.closeStart === parent.end)
    return replace(xml, parent, withAttrs(xml, parent, {}, value));
  return xml.source.slice(0, offset) + value + xml.source.slice(offset);
}
export function setChild(
  xml: XmlPart,
  name: string,
  value: string,
  sequence = order,
  append = false,
) {
  const old = append ? undefined : unique(xml.root, name);
  if (old && !append) return replace(xml, old, value);
  if (!value) return xml.source;
  const rank = sequence.indexOf(name);
  const next = xml.root.children.find(
    (n) => n.uri === xml.root.uri && sequence.indexOf(n.name) > rank,
  );
  return insert(xml, xml.root, value, next?.start ?? xml.root.closeStart);
}
export function patches(xml: XmlPart, edits: { start: number; end: number; value: string }[]) {
  edits.sort((a, b) => b.start - a.start);
  let source = xml.source,
    boundary = source.length;
  for (const edit of edits) {
    if (edit.end > boundary) throw new Error("office_target_ambiguous");
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
    boundary = edit.start;
  }
  return source;
}

export function nextOffset(sorted: [number, Element][], index: number, fallback: number) {
  let low = 0,
    high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sorted[mid]?.[0] ?? Infinity) <= index) low = mid + 1;
    else high = mid;
  }
  return sorted[low]?.[1].start ?? fallback;
}
