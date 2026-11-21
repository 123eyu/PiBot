import { posix } from "node:path";
import { DOC_REL, resolveTarget, STRICT_REL } from "../ooxml/package.ts";
import {
  descendants,
  localName,
  type OfficeArchive,
  requiredXml,
  type XmlNode,
} from "./archive.ts";

function relationships(xml: Map<string, XmlNode[]>, part: string) {
  const rels = posix.join(posix.dirname(part), "_rels", `${posix.basename(part)}.rels`);
  return descendants(xml.get(rels) ?? [], "Relationship");
}

function localTarget(
  part: string,
  rel: XmlNode | undefined,
  available: { has(path: string): boolean },
) {
  const target = rel?.attributes.Target;
  if (!target || rel.attributes.TargetMode === "External") return;
  try {
    const path = resolveTarget(part, target);
    if (available.has(path)) return path;
  } catch {
    // The caller treats an invalid target as an unresolved render relationship.
  }
}

export function relatedPart(xml: Map<string, XmlNode[]>, part: string, type: string, id?: string) {
  const matches = relationships(xml, part).filter(
    (rel) =>
      rel.attributes.Type?.endsWith(`/${type}`) && (id === undefined || rel.attributes.Id === id),
  );
  return localTarget(part, matches.length === 1 ? matches[0] : undefined, xml);
}

/** Index once: a slide can contain many distinct images and relationships. */
export function resolvedImages(xml: Map<string, XmlNode[]>, part: string, archive: OfficeArchive) {
  const images = new Set<string>();
  const seen = new Set<string>();
  for (const rel of relationships(xml, part)) {
    const id = rel.attributes.Id;
    if (!id || !rel.attributes.Type?.endsWith("/image")) continue;
    if (seen.has(id)) images.delete(id);
    else if (localTarget(part, rel, archive)) images.add(id);
    seen.add(id);
  }
  return images;
}

export function child(node: XmlNode | undefined, name: string) {
  return node?.children.find((item) => localName(item) === name);
}

export function mainOfficePart(files: OfficeArchive) {
  const matches = descendants(requiredXml(files, "_rels/.rels"), "Relationship").filter((node) =>
    [DOC_REL, STRICT_REL].some((uri) => node.attributes.Type === `${uri}/officeDocument`),
  );
  const rel = matches.length === 1 ? matches[0] : undefined;
  if (!rel?.attributes.Target || rel.attributes.TargetMode === "External")
    throw new Error("office_invalid_document");
  const part = resolveTarget("", rel.attributes.Target);
  if (!files.has(part)) throw new Error("office_invalid_document");
  return part;
}
