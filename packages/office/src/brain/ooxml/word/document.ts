import { posix } from "node:path";
import type { WordOperation as WordEditOperation } from "@pibot/protocol-base/office-ooxml";
import { locate, one } from "../locate.ts";
import { DOC_REL, type OfficePackage, REL_NS, relationshipPart, STRICT_REL } from "../package.ts";
import {
  attribute,
  type Element,
  elements,
  encoder,
  escapeXml,
  leafText,
  type XmlPart,
} from "../xml.ts";
import { propertyValue } from "./properties.ts";

export type WordOperation = WordEditOperation;
export type WordLocator = Extract<WordOperation, { locator: unknown }>["locator"];
export type RunFormat = Extract<WordOperation, { op: "word_format" }>["format"];
export const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const W14 = "http://schemas.microsoft.com/office/word/2010/wordml";
export const W15 = "http://schemas.microsoft.com/office/word/2012/wordml";
export class WordDocument {
  readonly main: string;
  readonly uri: string;
  readonly pkg: OfficePackage;
  readonly author: string;
  readonly date: string;
  readonly images: Record<string, Uint8Array>;
  constructor(
    pkg: OfficePackage,
    author: string,
    date: string,
    images: Record<string, Uint8Array> = {},
  ) {
    this.pkg = pkg;
    this.author = author;
    this.date = date;
    this.images = images;
    this.main = pkg.mainPart();
    const root = pkg.xml(this.main).root;
    this.uri = root.uri;
    if (
      root.name !== "document" ||
      ![W, "http://purl.oclc.org/ooxml/wordprocessingml/main"].includes(this.uri)
    )
      throw new Error("office_unsupported");
  }
  tag(name: string, attrs: Record<string, string | number> = {}, body?: string) {
    const a = Object.entries(attrs)
      .map(([k, v]) => ` w:${k}="${escapeXml(String(v))}"`)
      .join("");
    return `<w:${name} xmlns:w="${this.uri}"${a}${body === undefined ? "/>" : `>${body}</w:${name}>`}`;
  }
  raw(xml: XmlPart, node: Element) {
    return xml.source.slice(node.start, node.end);
  }
  text(value: string, deleted = false) {
    return this.tag(deleted ? "delText" : "t", {}, escapeXml(value)).replace(
      " xmlns:w=",
      ' xml:space="preserve" xmlns:w=',
    );
  }
  run(value: string, props = "", deleted = false) {
    return this.tag("r", {}, props + this.text(value, deleted));
  }
  attr(node: Element, key: string) {
    return attribute(node, key, this.uri);
  }
  all(xml: XmlPart, name: string) {
    return Array.from(elements(xml.root)).filter((n) => n.uri === this.uri && n.name === name);
  }
  child(node: Element, name: string) {
    return node.children.find((n) => n.uri === this.uri && n.name === name);
  }
  body(xml = this.pkg.xml(this.main)) {
    return one(xml.root.children.filter((n) => n.uri === this.uri && n.name === "body"));
  }
  patch(part: string, xml: XmlPart, edits: { start: number; end: number; value: string }[]) {
    let source = xml.source,
      next = source.length;
    for (const e of edits.sort((a, b) => b.start - a.start)) {
      if (e.end > next || e.start > e.end) throw new Error("office_target_ambiguous");
      source = source.slice(0, e.start) + e.value + source.slice(e.end);
      next = e.start;
    }
    this.pkg.replaceXml(part, source);
  }
  replace(part: string, xml: XmlPart, node: Element, value: string) {
    this.patch(part, xml, [{ start: node.start, end: node.end, value }]);
  }
  insert(part: string, xml: XmlPart, node: Element, value: string) {
    if (node.closeStart === node.end) {
      const raw = this.raw(xml, node),
        qname = /^<([^\s/>]+)/u.exec(raw)?.[1];
      if (!qname) throw new Error("office_invalid");
      this.replace(part, xml, node, `${raw.slice(0, -2)}>${value}</${qname}>`);
    } else this.patch(part, xml, [{ start: node.closeStart, end: node.closeStart, value }]);
  }
  propertyValue(xml: XmlPart, node: Element, kind: string, changes: Record<string, string>) {
    return propertyValue(this, xml, node, kind, changes);
  }
  withProps(xml: XmlPart, node: Element, kind: string, changes: Record<string, string>) {
    const old = this.child(node, kind),
      value = this.propertyValue(xml, node, kind, changes),
      raw = this.raw(xml, node);
    if (old) return raw.slice(0, old.start - node.start) + value + raw.slice(old.end - node.start);
    if (node.closeStart === node.end) {
      const q = /^<([^\s/>]+)/u.exec(raw)?.[1];
      return `${raw.slice(0, -2)}>${value}</${q}>`;
    }
    return raw.slice(0, node.openEnd - node.start) + value + raw.slice(node.openEnd - node.start);
  }
  props(part: string, xml: XmlPart, node: Element, kind: string, changes: Record<string, string>) {
    const old = this.child(node, kind),
      value = this.propertyValue(xml, node, kind, changes);
    if (old) this.replace(part, xml, old, value);
    else if (node.closeStart === node.end) this.insert(part, xml, node, value);
    else this.patch(part, xml, [{ start: node.openEnd, end: node.openEnd, value }]);
  }
  target(locator: WordLocator) {
    const located = locate(this.pkg, "docx", locator);
    const paragraphs = this.all(located.xml, "p").filter((p) =>
      located.nodes.some((n) => n.start >= p.openEnd && n.end <= p.closeStart),
    );
    // Empty paragraphs are still valid insertion targets.
    if (!paragraphs.length && locator.kind === "word_paragraph") {
      const p = this.all(located.xml, "p")[locator.paragraph - 1];
      if (p) paragraphs.push(p);
    }
    return { ...located, paragraphs };
  }
  paragraph(locator: WordLocator) {
    const t = this.target(locator);
    return { ...t, paragraph: one(t.paragraphs) };
  }
  storyParts() {
    return [
      ...new Set([
        this.main,
        ...this.pkg
          .relationships(this.main)
          .filter(
            (r) => !r.external && /\/(?:header|footer|footnotes|endnotes|comments)$/u.test(r.type),
          )
          .flatMap((r) => (r.target ? [r.target] : [])),
      ]),
    ];
  }
  // One numeric space prevents collisions between newly authored story annotations.
  nextStoryId(count = 1) {
    let max = 0;
    for (const part of this.storyParts())
      for (const node of elements(this.pkg.xml(part).root)) {
        const id =
          node.uri === this.uri
            ? this.attr(node, "id")
            : node.name === "docPr" && /\/wordprocessingDrawing$/u.test(node.uri)
              ? node.attrs.get("id")
              : undefined;
        if (id && /^\d+$/u.test(id)) max = Math.max(max, Number(id));
      }
    if (max + count > 0x7fff_ffff) throw new Error("office_content_limit");
    return max + 1;
  }
  alignment(value: string) {
    return this.uri !== W && ["left", "right"].includes(value)
      ? value === "left"
        ? "start"
        : "end"
      : value;
  }
  nextId(names: string[], parts = [this.main]) {
    let max = 0;
    for (const part of parts)
      for (const n of elements(this.pkg.xml(part).root))
        if (n.uri === this.uri && names.includes(n.name)) {
          const id = this.attr(
            n,
            n.name === "abstractNum" ? "abstractNumId" : n.name === "num" ? "numId" : "id",
          );
          if (id && /^\d+$/u.test(id)) max = Math.max(max, Number(id));
        }
    if (max >= 0x7fff_ffff) throw new Error("office_content_limit");
    return max + 1;
  }
  related(suffix: string) {
    const matches = this.pkg
      .relationships(this.main)
      .filter((r) => r.type === `${DOC_REL}/${suffix}` || r.type === `${STRICT_REL}/${suffix}`);
    if (matches.length > 1 || matches.some((r) => !r.target))
      throw new Error("office_target_ambiguous");
    return matches[0]?.target;
  }
  relationship(target: string, suffix: string, external = false, typeOverride?: string) {
    const rels = this.pkg.relationships(this.main);
    let n = 1;
    while (rels.some((r) => r.id === `rIdPiBot${n}`)) n++;
    const id = `rIdPiBot${n}`,
      type = typeOverride ?? `${this.uri === W ? DOC_REL : STRICT_REL}/${suffix}`;
    if (!external)
      this.pkg.addRelationship(
        this.main,
        id,
        type,
        posix.relative(posix.dirname(this.main), target),
      );
    else {
      // External links are inert document data; only explicit web/mail links are admitted, never fetched.
      if (!/^(?:https?:\/\/|mailto:)[^\s\p{Cc}]+$/u.test(target))
        throw new Error("office_unsupported");
      const part = relationshipPart(this.main),
        entry = `<Relationship xmlns="${REL_NS}" Id="${id}" Type="${type}" Target="${escapeXml(target)}" TargetMode="External"/>`;
      if (!this.pkg.has(part)) throw new Error("office_missing_part");
      const xml = this.pkg.xml(part);
      this.insert(part, xml, xml.root, entry);
    }
    return id;
  }
  part(
    suffix: string,
    root: string,
    contentType = `application/vnd.openxmlformats-officedocument.wordprocessingml.${suffix}+xml`,
    uri = this.uri,
  ) {
    const found = this.related(suffix);
    if (found) return found;
    let n = 0,
      part: string;
    do {
      part = posix.join(posix.dirname(this.main), `${suffix}${n || ""}.xml`);
      n++;
    } while (this.pkg.has(part));
    this.pkg.addPart(part, encoder.encode(`<w:${root} xmlns:w="${uri}"/>`), contentType);
    this.relationship(part, suffix);
    return part;
  }
  format(format: RunFormat) {
    let value = "";
    for (const [key, tag] of [
      ["bold", "b"],
      ["italic", "i"],
      ["strike", "strike"],
    ] as const)
      if (format[key] !== undefined) value += this.tag(tag, { val: format[key] ? "1" : "0" });
    if (format.font)
      value =
        this.tag("rFonts", { ascii: format.font, hAnsi: format.font, eastAsia: format.font }) +
        value;
    if (format.color) value += this.tag("color", { val: format.color });
    if (format.size) value += this.tag("sz", { val: format.size });
    if (format.highlight) value += this.tag("highlight", { val: format.highlight });
    if (format.underline !== undefined)
      value += this.tag("u", { val: format.underline ? "single" : "none" });
    if (format.script) value += this.tag("vertAlign", { val: format.script });
    return value;
  }
  revision(kind: "ins" | "del", id: number, body: string) {
    return this.tag(kind, { id, author: this.author, date: this.date }, body);
  }
  plain(xml: XmlPart, node: Element) {
    return Array.from(elements(node))
      .filter((n) => n.uri === this.uri && n.name === "t")
      .map((n) => leafText(xml, n) ?? "")
      .join("");
  }
}
