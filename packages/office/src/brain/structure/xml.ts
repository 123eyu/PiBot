import { DOC_REL, STRICT_REL } from "../ooxml/package.ts";
import { attribute, type Element, elements, leafText, type XmlPart } from "../ooxml/xml.ts";
import type { StructurePackage } from "./package.ts";

export const WORD = "wordprocessingml";
export const SHEET = "spreadsheetml";
export const PRESENTATION = "presentationml";
export const DRAW = "drawingml";

export function belongs(node: Element, family: string) {
  return (
    node.uri === `http://schemas.openxmlformats.org/${family}/2006/main` ||
    node.uri === `http://purl.oclc.org/ooxml/${family}/main`
  );
}
export const child = (node: Element, name: string, family: string) =>
  node.children.find((item) => item.name === name && belongs(item, family));
export function* nodes(node: Element, name: string, family: string) {
  for (const item of elements(node)) if (item.name === name && belongs(item, family)) yield item;
}
export const attr = (node: Element | undefined, name: string) => node && attribute(node, name);
export const wordAttr = (node: Element | undefined, name: string) =>
  node && attribute(node, name, node.uri);
export const relId = (node: Element, name = "id") =>
  attribute(node, name, DOC_REL) ?? attribute(node, name, STRICT_REL);

export function relations(pkg: StructurePackage, source: string) {
  const result = new Map<string, { kind: string; part?: string }>();
  for (const rel of pkg.relationships(source)) {
    if (result.has(rel.id)) {
      pkg.problem(source, "invalid_relationship");
      continue;
    }
    const prefix = [DOC_REL, STRICT_REL].find((uri) => rel.type.startsWith(`${uri}/`));
    result.set(rel.id, {
      kind: prefix ? rel.type.slice(prefix.length + 1) : "",
      part: rel.target,
    });
  }
  return result;
}
export type Relations = ReturnType<typeof relations>;
export function target(rels: Relations, node: Element, kind: string, name?: string) {
  const rel = rels.get(relId(node, name) ?? "");
  return rel?.kind === kind ? rel.part : undefined;
}
export const byKind = (rels: Relations, kind: string) =>
  [...rels.values()].flatMap((rel) => (rel.kind === kind && rel.part ? [rel.part] : []));

export class TextBudget {
  truncated = false;
  clip(value: string | undefined, max = 2_000) {
    if (value === undefined) return;
    if (value.length <= max) return value;
    this.truncated = true;
    // Avoid splitting a surrogate pair at the output boundary.
    return value.slice(0, max).replace(/[\uD800-\uDBFF]$/u, "");
  }
  text(xml: XmlPart, node: Element, family: string, separator = "") {
    let result = "";
    for (const item of nodes(node, "t", family)) {
      const next = leafText(xml, item);
      if (!next) continue;
      result += (result ? separator : "") + next;
      if (result.length > 2_000) return this.clip(result) ?? "";
    }
    return result;
  }
}
export function natural(value: string | undefined) {
  if (value === undefined || !/^\d+$/u.test(value)) return;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
