import type { OfficePackage } from "./package.ts";
import { DOC_REL, STRICT_REL } from "./package.ts";
import type { Element } from "./xml.ts";
import { attribute } from "./xml.ts";

export type SchemaIssue = (
  ...finding:
    | [code: "invalid_schema", rule: string, dependencies?: readonly string[]]
    | [code: "invalid_relationship" | "missing_relationship" | "invalid_content_types"]
) => void;

export interface SchemaFinding {
  part: string;
  rule: string;
  dependencies: readonly string[];
}
export const child = (node: Element, name: string) =>
  node.children.find((item) => item.uri === node.uri && item.name === name);
export const children = (node: Element, name: string) =>
  node.children.filter((item) => item.uri === node.uri && item.name === name);
export const relId = (node: Element) =>
  attribute(node, "id", DOC_REL) ?? attribute(node, "id", STRICT_REL);
export function related(pkg: OfficePackage, part: string, kind: string, id?: string) {
  return pkg
    .relationships(part)
    .filter(
      (rel) =>
        !rel.external &&
        [DOC_REL, STRICT_REL].some((ns) => rel.type === `${ns}/${kind}`) &&
        (id === undefined || rel.id === id),
    );
}
export function counted(node: Element, name: string, add: SchemaIssue) {
  const list = child(node, name);
  if (
    list?.attrs.has("count") &&
    Number(list.attrs.get("count")) !== list.children.filter((item) => item.uri === list.uri).length
  )
    add("invalid_schema", `count:${node.name}/${name}`);
  return list;
}
export function required(node: Element, names: string[], add: SchemaIssue) {
  for (const name of names)
    if (!child(node, name)) add("invalid_schema", `required:${node.name}/${name}`);
}
