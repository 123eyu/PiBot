import type { OfficeStructureItem } from "@pibot/protocol-base/office-content";
import {
  DOC_REL,
  OfficePackage,
  relationshipPart,
  relationshipSource,
  STRICT_REL,
  TYPES,
} from "../ooxml/package.ts";
import { elements, type XmlPart } from "../ooxml/xml.ts";
import type { Summary } from "./page.ts";

/** Request-local cache only. Safety scans still inspect every XML, including unselected parts. */
export class StructurePackage {
  private readonly pkg: OfficePackage;
  private readonly cache = new Map<string, XmlPart>();
  private cacheBytes = 0;
  private readonly problemKeys = new Set<string>();
  private readonly relCache = new Map<string, ReturnType<OfficePackage["relationships"]>>();
  readonly problems: Extract<OfficeStructureItem, { kind: "problem" }>[] = [];
  constructor(pkg: OfficePackage) {
    this.pkg = pkg;
  }
  has(part: string) {
    return this.pkg.has(part);
  }
  xml(part: string) {
    const cached = this.cache.get(part);
    if (cached) return cached;
    const xml = this.pkg.xml(part);
    this.remember(part, xml);
    return xml;
  }
  private remember(part: string, xml: XmlPart) {
    const size = Buffer.byteLength(xml.source, "utf8");
    if (this.cacheBytes + size <= 4 * 1024 * 1024) {
      this.cache.set(part, xml);
      this.cacheBytes += size;
    }
  }
  relationships(source: string) {
    const cached = this.relCache.get(source);
    if (cached) return cached;
    const part = relationshipPart(source);
    if (!this.has(part)) return [];
    // OfficePackage validates relationship semantics; use its cached XML through a
    // request-local facade rather than reparse the same rels for each consumer.
    const facade = { xml: (name: string) => this.xml(name), has: (name: string) => this.has(name) };
    try {
      const result = OfficePackage.prototype.relationships.call(facade as OfficePackage, source);
      this.relCache.set(source, result);
      return result;
    } catch (error) {
      if (
        !(error instanceof URIError) &&
        (!(error instanceof Error) || error.message !== "office_invalid_relationship")
      )
        throw error;
      this.problem(part, "invalid_relationship");
      this.relCache.set(source, []);
      return [];
    }
  }
  mainPart() {
    const candidates = this.relationships("").filter((rel) =>
      [DOC_REL, STRICT_REL].some((base) => rel.type === `${base}/officeDocument`),
    );
    const part = candidates.length === 1 ? candidates[0]?.target : undefined;
    if (!part || !this.has(part)) throw new Error("office_missing_part");
    return part;
  }
  problem(part: string, code: "invalid_relationship" | "missing_part" | "missing_cell_address") {
    const key = `${part}\0${code}`;
    if (!this.problemKeys.has(key)) {
      this.problemKeys.add(key);
      this.problems.push({ kind: "problem", part, code });
    }
  }
  optional(part: string | undefined, owner: string) {
    if (part && this.has(part)) return this.xml(part);
    this.problem(part ?? owner, "missing_part");
    return undefined;
  }
  validate(summary: Summary) {
    if (!this.has(TYPES) || !this.has("_rels/.rels")) throw new Error("office_missing_part");
    for (const part of this.pkg.names()) {
      if (part.endsWith(".xml") || part.endsWith(".rels")) {
        const xml = this.xml(part);
        if (part === TYPES)
          for (const node of elements(xml.root))
            if (/macroEnabled|vbaProject|activeX/iu.test(node.attrs.get("ContentType") ?? ""))
              summary.macros = true;
      }
      if (/vbaProject|vbaData|macrosheets|activeX/iu.test(part)) summary.macros = true;
      if (part.endsWith(".rels")) {
        const source = relationshipSource(part);
        if (source !== undefined)
          summary.externalLinks =
            this.relationships(source).some((rel) => rel.external) || summary.externalLinks;
      }
    }
  }
}
