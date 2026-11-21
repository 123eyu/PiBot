import { posix } from "node:path";
import { type OfficeArchive, packArchive, readArchive } from "../codecs/archive.ts";
import { encoder, escapeXml, parsePart } from "./xml.ts";

export const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
export const TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
export const DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const STRICT_REL = "http://purl.oclc.org/ooxml/officeDocument/relationships";
export const TYPES = "[Content_Types].xml";

function validPart(part: string) {
  return (
    part.length > 0 &&
    part.length <= 512 &&
    !/[\\?#:\p{Cc}]/u.test(part) &&
    part.split("/").every((item) => item && item !== "." && item !== "..")
  );
}
export function relationshipPart(source: string) {
  return source
    ? posix.join(posix.dirname(source), "_rels", `${posix.basename(source)}.rels`)
    : "_rels/.rels";
}
export function relationshipSource(part: string) {
  if (part === "_rels/.rels") return "";
  const match = /^(?:(.*)\/)?_rels\/([^/]+)\.rels$/u.exec(part);
  return match ? (match[1] ? `${match[1]}/${match[2]}` : match[2]) : undefined;
}
export function resolveTarget(source: string, target: string) {
  if (!target || target.length > 1536 || /[\\?#:\p{Cc}]/u.test(target))
    throw new Error("office_invalid_relationship");
  const segments = target.startsWith("/") ? [] : source.split("/").slice(0, -1);
  for (const raw of target.replace(/^\//u, "").split("/")) {
    const segment = decodeURIComponent(raw);
    if (segment.includes("/") || !segment) throw new Error("office_invalid_relationship");
    if (segment === "..") {
      if (!segments.length) throw new Error("office_invalid_relationship");
      segments.pop();
    } else if (segment !== ".") segments.push(segment);
  }
  const part = segments.join("/");
  if (!validPart(part) || part === TYPES || relationshipSource(part) !== undefined)
    throw new Error("office_invalid_relationship");
  return part;
}

export class OfficePackage {
  private readonly files: OfficeArchive;
  private constructor(files: OfficeArchive) {
    this.files = files;
  }
  static async open(bytes: Uint8Array) {
    return new OfficePackage(await readArchive(bytes));
  }
  names() {
    return this.files.keys();
  }
  has(part: string) {
    return this.files.has(part);
  }
  readPart(part: string) {
    const bytes = this.files.get(part);
    return bytes && Uint8Array.from(bytes);
  }
  replacePart(part: string, bytes: Uint8Array) {
    if (!this.has(part)) throw new Error("office_missing_part");
    // Callers cannot mutate the transaction later through a retained input buffer.
    this.files.set(part, Uint8Array.from(bytes));
  }
  xml(part: string) {
    const bytes = this.files.get(part);
    if (!bytes) throw new Error("office_missing_part");
    return parsePart(bytes);
  }
  relationships(source: string) {
    const part = relationshipPart(source);
    if (!this.has(part)) return [];
    const { root } = this.xml(part);
    if (root.name !== "Relationships" || root.uri !== REL_NS)
      throw new Error("office_invalid_relationship");
    return root.children.map((node) => {
      const id = node.attrs.get("Id"),
        type = node.attrs.get("Type"),
        target = node.attrs.get("Target");
      const mode = node.attrs.get("TargetMode");
      if (
        node.name !== "Relationship" ||
        node.uri !== REL_NS ||
        !id ||
        !type ||
        !target ||
        (mode !== undefined && mode !== "External" && mode !== "Internal")
      )
        throw new Error("office_invalid_relationship");
      return {
        id,
        type,
        external: mode === "External",
        target: mode === "External" ? undefined : resolveTarget(source, target),
      };
    });
  }
  mainPart() {
    const matches = this.relationships("").filter(
      ({ type }) => type === `${DOC_REL}/officeDocument` || type === `${STRICT_REL}/officeDocument`,
    );
    if (matches.length !== 1 || !matches[0]?.target) throw new Error("office_missing_part");
    return matches[0].target;
  }
  replaceXml(part: string, source: string) {
    if (!this.has(part)) throw new Error("office_missing_part");
    const bytes = encoder.encode(source);
    parsePart(bytes);
    this.files.set(part, bytes);
  }
  addPart(part: string, bytes: Uint8Array, contentType: string) {
    if (
      !validPart(part) ||
      this.has(part) ||
      part === TYPES ||
      relationshipSource(part) !== undefined
    )
      throw new Error("office_invalid_part");
    const { root, source } = this.xml(TYPES);
    if (root.name !== "Types" || root.uri !== TYPES_NS) throw new Error("office_invalid_part");
    const name = part.split("/").map(encodeURIComponent).join("/");
    const entry = `<Override xmlns="${TYPES_NS}" PartName="/${name}" ContentType="${escapeXml(contentType)}"/>`;
    this.replaceXml(TYPES, insertChild(source, root, entry));
    this.files.set(part, Uint8Array.from(bytes));
  }
  /**
   * Copies a `.rels` part verbatim. `addPart` refuses relationship parts because their type belongs to
   * the source part, and duplicating a slide must keep its layout/image relationship ids stable.
   */
  addRelationshipPart(part: string, bytes: Uint8Array) {
    if (relationshipSource(part) === undefined || this.has(part))
      throw new Error("office_invalid_part");
    parsePart(bytes);
    this.files.set(part, Uint8Array.from(bytes));
  }
  addRelationship(source: string, id: string, type: string, target: string) {
    if (
      (source && !this.has(source)) ||
      !this.has(resolveTarget(source, target)) ||
      this.relationships(source).some((rel) => rel.id === id) ||
      !id ||
      !type
    )
      throw new Error("office_invalid_relationship");
    const part = relationshipPart(source);
    const entry = `<Relationship xmlns="${REL_NS}" Id="${escapeXml(id)}" Type="${escapeXml(type)}" Target="${escapeXml(target)}"/>`;
    if (this.has(part)) {
      const xml = this.xml(part);
      this.replaceXml(part, insertChild(xml.source, xml.root, entry));
    } else
      this.files.set(
        part,
        encoder.encode(`<Relationships xmlns="${REL_NS}">${entry}</Relationships>`),
      );
  }
  write() {
    this.pruneDanglingOverrides();
    return packArchive(this.files);
  }
  /**
   * PowerPoint opens a file whose Content_Types registers parts that are gone, so validation only
   * warns; a package we write back should not carry the dead entries forward.
   */
  private pruneDanglingOverrides() {
    if (!this.has(TYPES)) return;
    const { root, source } = this.xml(TYPES);
    if (root.name !== "Types" || root.uri !== TYPES_NS) return;
    const ranges: [number, number][] = [];
    for (const node of root.children) {
      if (node.name !== "Override" || node.uri !== TYPES_NS) continue;
      const name = node.attrs.get("PartName");
      if (!name?.startsWith("/")) continue;
      let part: string;
      try {
        part = resolveTarget("", name);
      } catch {
        // An unparseable PartName is left alone: `validate` reports the registry itself.
        continue;
      }
      if (!this.has(part)) ranges.push([node.start, node.end]);
    }
    if (!ranges.length) return;
    let next = source;
    for (const [start, end] of ranges.sort((a, b) => b[0] - a[0]))
      next = next.slice(0, start) + next.slice(end);
    this.replaceXml(TYPES, next);
  }
}

function insertChild(source: string, root: ReturnType<typeof parsePart>["root"], entry: string) {
  if (root.closeStart !== root.end)
    return source.slice(0, root.closeStart) + entry + source.slice(root.closeStart);
  const name = /^<([^\s/>]+)/u.exec(source.slice(root.start, root.openEnd))?.[1];
  if (!name) throw new Error("office_invalid_xml");
  return `${source.slice(0, root.end - 2)}>${entry}</${name}>${source.slice(root.end)}`;
}
