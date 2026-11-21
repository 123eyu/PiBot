import { DOC_REL, type OfficePackage, STRICT_REL } from "../package.ts";
import { attribute, type Element, elements, type XmlPart } from "../xml.ts";

const SHAPES = new Set(["sp", "pic", "graphicFrame", "cxnSp", "grpSp"]);

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Edit {
  start: number;
  end: number;
  text: string;
}
export interface Deck {
  pkg: OfficePackage;
  part: string;
  xml: XmlPart;
  list: Element;
  slides: Element[];
}

export function deck(pkg: OfficePackage): Deck {
  const part = pkg.mainPart();
  const xml = pkg.xml(part);
  const list = xml.root.children.find(
    (node) => node.uri === xml.root.uri && node.name === "sldIdLst",
  );
  if (!list) throw new Error("office_invalid");
  return {
    pkg,
    part,
    xml,
    list,
    slides: list.children.filter((node) => node.uri === list.uri && node.name === "sldId"),
  };
}

export function slidePart(pkg: OfficePackage, slide: number) {
  const { part, slides } = deck(pkg);
  const item = slides[slide - 1];
  const id = item && (attribute(item, "id", DOC_REL) ?? attribute(item, "id", STRICT_REL));
  if (!item || !id) throw new Error("office_target_ambiguous");
  const rel = pkg.relationships(part).find((entry) => entry.id === id);
  if (!rel?.target || ![DOC_REL, STRICT_REL].some((base) => rel.type === `${base}/slide`))
    throw new Error("office_target_ambiguous");
  return { part: rel.target, xml: pkg.xml(rel.target) };
}

export function slideSize(pkg: OfficePackage) {
  const { xml } = deck(pkg);
  const size = xml.root.children.find((node) => node.uri === xml.root.uri && node.name === "sldSz");
  const width = Number(size?.attrs.get("cx")),
    height = Number(size?.attrs.get("cy"));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new Error("office_unsupported");
  return { width, height };
}

export function shapeTree(xml: XmlPart) {
  const common = xml.root.children.find(
    (node) => node.uri === xml.root.uri && node.name === "cSld",
  );
  const tree = common?.children.find((node) => node.uri === xml.root.uri && node.name === "spTree");
  if (!tree) throw new Error("office_invalid");
  return tree;
}

export function shapesIn(tree: Element) {
  return tree.children.filter((node) => node.uri === tree.uri && SHAPES.has(node.name));
}

function nonVisual(node: Element) {
  return node.children.find((item) => item.uri === node.uri && item.name.startsWith("nv"));
}
function cNvPr(node: Element) {
  const nv = nonVisual(node);
  return nv?.children.find((item) => item.uri === node.uri && item.name === "cNvPr");
}

export function shapeNode(xml: XmlPart, id: number) {
  const tree = shapeTree(xml);
  const nodes = shapesIn(tree).filter((node) => {
    const props = cNvPr(node);
    return props && props.attrs.get("id") === String(id);
  });
  if (nodes.length !== 1 || !nodes[0]) throw new Error("office_target_ambiguous");
  return nodes[0];
}

export function shapeIds(xml: XmlPart) {
  let max = 1;
  for (const node of elements(xml.root))
    if (node.name === "cNvPr") {
      const value = Number(node.attrs.get("id"));
      if (Number.isSafeInteger(value) && value > max) max = value;
    }
  return max;
}

export function xfrmOf(node: Element) {
  if (node.name === "graphicFrame")
    return node.children.find((item) => item.uri === node.uri && item.name === "xfrm");
  const name = node.name === "grpSp" ? "grpSpPr" : "spPr";
  const props = node.children.find((item) => item.uri === node.uri && item.name === name);
  return props?.children.find((item) => item.name === "xfrm");
}

function extent(xfrm: Element, name: string) {
  const node = xfrm.children.find((item) => item.name === name);
  return node;
}
function numeric(node: Element | undefined, name: string) {
  const value = node?.attrs.get(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function frameOf(node: Element): Frame {
  const xfrm = xfrmOf(node);
  const off = xfrm && extent(xfrm, "off"),
    ext = xfrm && extent(xfrm, "ext");
  const x = numeric(off, "x"),
    y = numeric(off, "y"),
    width = numeric(ext, "cx"),
    height = numeric(ext, "cy");
  if (x === undefined || y === undefined || width === undefined || height === undefined)
    throw new Error("office_unsupported");
  return { x, y, width, height };
}

export function qualifiedTag(source: string, node: Element) {
  const tag = /^<([^\s/>]+)/u.exec(source.slice(node.start, node.openEnd))?.[1];
  if (!tag) throw new Error("office_invalid_xml");
  return tag;
}

/** Only supplied frame parts are rewritten, so untouched offsets keep their original text. */
export function frameEdits(source: string, node: Element, frame: Frame): Edit[] {
  const xfrm = xfrmOf(node);
  const off = xfrm && extent(xfrm, "off"),
    ext = xfrm && extent(xfrm, "ext");
  if (!xfrm || !off || !ext) throw new Error("office_unsupported");
  const offset = `<${qualifiedTag(source, off)} x="${Math.round(frame.x)}" y="${Math.round(frame.y)}"/>`;
  const size = `<${qualifiedTag(source, ext)} cx="${Math.max(1, Math.round(frame.width))}" cy="${Math.max(1, Math.round(frame.height))}"/>`;
  return [
    { start: off.start, end: off.end, text: offset },
    { start: ext.start, end: ext.end, text: size },
  ];
}

export function apply(source: string, edits: Edit[]) {
  const sorted = [...edits].sort((left, right) => right.start - left.start);
  let result = source;
  let limit = source.length;
  for (const edit of sorted) {
    if (edit.end > limit || edit.start < 0) throw new Error("office_invalid");
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    limit = edit.start;
  }
  return result;
}

/** Renders one node with its frame replaced, relative to the node's own span. */
export function rewriteNode(source: string, node: Element, frame: Frame) {
  const edits = frameEdits(source, node, frame).map((edit) => ({
    start: edit.start - node.start,
    end: edit.end - node.start,
    text: edit.text,
  }));
  return apply(source.slice(node.start, node.end), edits);
}

export function treeSource(source: string, tree: Element, nodes: Element[]) {
  return (
    source.slice(0, tree.openEnd) +
    nodes.map((node) => source.slice(node.start, node.end)).join("") +
    source.slice(tree.closeStart)
  );
}
