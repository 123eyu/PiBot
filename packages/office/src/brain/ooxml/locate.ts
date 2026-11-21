import type { OfficeFormat, OfficeLocator } from "@pibot/protocol-base";
import { DOC_REL, type OfficePackage, STRICT_REL } from "./package.ts";
import { headingResolver } from "./word/headings.ts";
import { attribute, type Element, elements, leafText, type XmlPart } from "./xml.ts";

const drawings = new Set([
  "http://schemas.openxmlformats.org/drawingml/2006/main",
  "http://purl.oclc.org/ooxml/drawingml/main",
]);
export function one<T>(items: T[]): T {
  const item = items[0];
  if (items.length !== 1 || item === undefined) throw new Error("office_target_ambiguous");
  return item;
}
/**
 * A miss and a duplicate need different advice ("check the slide/shape" vs "the text is split"),
 * and callers kept retrying blindly while both reported the same "no unique match".
 */
function single<T>(items: T[]): T {
  const item = items[0];
  if (items.length > 1) throw new Error("office_target_ambiguous");
  if (item === undefined) throw new Error("office_target_missing");
  return item;
}
/**
 * PowerPoint's UI calls `title` and `ctrTitle` both "Title", and a placeholder without a type is
 * the generic content box; one locator name has to reach each of them.
 */
const placeholderTypes: Record<string, string[]> = {
  title: ["title", "ctrtitle"],
  ctrtitle: ["title", "ctrtitle"],
  body: ["body", "obj"],
  obj: ["body", "obj"],
};
function relId(node: Element) {
  return attribute(node, "id", DOC_REL) ?? attribute(node, "id", STRICT_REL);
}
function related(pkg: OfficePackage, part: string, suffix: string, id?: string) {
  const rel = one(
    pkg
      .relationships(part)
      .filter(
        (item) =>
          (id === undefined || item.id === id) &&
          [`${DOC_REL}/${suffix}`, `${STRICT_REL}/${suffix}`].includes(item.type),
      ),
  );
  if (!rel.target) throw new Error("office_target_ambiguous");
  return rel.target;
}
export interface Located {
  part: string;
  xml: XmlPart;
  nodes: Element[];
  shared?: { part: string; xml: XmlPart; node: Element; item: Element };
}
function wordHeading(
  pkg: OfficePackage,
  part: string,
  xml: XmlPart,
  paragraphs: Element[],
  path: string[],
) {
  const resolveLevel = headingResolver(pkg, part);
  const trail: { level: number; text: string }[] = [];
  return one(
    paragraphs.filter((p) => {
      const level = resolveLevel(p);
      if (!level) return false;
      while ((trail.at(-1)?.level ?? 0) >= level) trail.pop();
      trail.push({
        level,
        text: wordText(p)
          .map((n) => leafText(xml, n) ?? "")
          .join(""),
      });
      return (
        trail.length === path.length && trail.every((value, index) => value.text === path[index])
      );
    }),
  );
}
function wordText(node: Element) {
  return Array.from(elements(node)).filter((child) => child.uri === node.uri && child.name === "t");
}
function word(pkg: OfficePackage, locator: OfficeLocator): Located {
  const part = pkg.mainPart(),
    xml = pkg.xml(part);
  const all = Array.from(elements(xml.root)).filter((n) => n.uri === xml.root.uri);
  const paragraphs = all.filter((n) => n.name === "p");
  const attr = (n: Element, key: string) => attribute(n, key, xml.root.uri);
  if (locator.kind === "word_bookmark") {
    const start = one(
      all.filter((n) => n.name === "bookmarkStart" && attr(n, "name") === locator.name),
    );
    const id = attr(start, "id");
    if (!id) throw new Error("office_target_ambiguous");
    const end = one(all.filter((n) => n.name === "bookmarkEnd" && attr(n, "id") === id));
    if (end.start < start.end) throw new Error("office_target_ambiguous");
    return {
      part,
      xml,
      nodes: wordText(xml.root).filter((n) => n.start >= start.end && n.end <= end.start),
    };
  }
  const target =
    locator.kind === "word_paragraph"
      ? paragraphs[locator.paragraph - 1]
      : locator.kind === "word_heading"
        ? wordHeading(pkg, part, xml, paragraphs, locator.path)
        : locator.kind === "word_content_control"
          ? one(
              all.filter(
                (n) =>
                  n.name === "sdt" &&
                  n.children.some(
                    (p) =>
                      p.name === "sdtPr" &&
                      p.uri === n.uri &&
                      p.children.some(
                        (tag) =>
                          tag.name === "tag" &&
                          tag.uri === n.uri &&
                          attr(tag, "val") === locator.tag,
                      ),
                  ),
              ),
            )
          : undefined;
  if (!target) throw new Error("office_target_ambiguous");
  return { part, xml, nodes: wordText(target) };
}

function excel(pkg: OfficePackage, locator: OfficeLocator): Located {
  const main = pkg.mainPart(),
    book = pkg.xml(main);
  const workbook = Array.from(elements(book.root)).filter((n) => n.uri === book.root.uri);
  const sheets = workbook.filter((n) => n.name === "sheet");
  if (locator.kind === "excel_defined_name")
    return {
      part: main,
      xml: book,
      nodes: [
        one(
          workbook.filter((n) => n.name === "definedName" && n.attrs.get("name") === locator.name),
        ),
      ],
    };
  if (locator.kind === "excel_table") {
    const matches: Located[] = [];
    for (const sheet of sheets) {
      const id = relId(sheet);
      if (!id) continue;
      const part = related(pkg, main, "worksheet", id);
      for (const rel of pkg.relationships(part)) {
        if (!rel.target || ![DOC_REL, STRICT_REL].some((prefix) => rel.type === `${prefix}/table`))
          continue;
        const xml = pkg.xml(rel.target);
        if (
          xml.root.uri === book.root.uri &&
          xml.root.name === "table" &&
          [xml.root.attrs.get("name"), xml.root.attrs.get("displayName")].includes(locator.name)
        )
          matches.push({ part: rel.target, xml, nodes: [xml.root] });
      }
    }
    return one(matches);
  }
  if (locator.kind !== "excel_cell") throw new Error("office_target_ambiguous");
  const address = /^(.+)!([A-Z]{1,3}[1-9][0-9]{0,6})$/u.exec(locator.address);
  if (!address) throw new Error("office_target_ambiguous");
  const sheet = one(sheets.filter((n) => n.attrs.get("name") === address[1]));
  const id = relId(sheet);
  if (!id) throw new Error("office_target_ambiguous");
  const part = related(pkg, main, "worksheet", id),
    xml = pkg.xml(part);
  const cell = one(
    Array.from(elements(xml.root)).filter(
      (n) => n.uri === book.root.uri && n.name === "c" && n.attrs.get("r") === address[2],
    ),
  );
  if (cell.children.some((n) => n.uri === cell.uri && n.name === "f"))
    throw new Error("office_unsupported");
  if (cell.attrs.get("t") === "inlineStr") return { part, xml, nodes: wordText(cell) };
  if (cell.attrs.get("t") !== "s") throw new Error("office_unsupported");
  const value = one(cell.children.filter((n) => n.uri === cell.uri && n.name === "v"));
  const index = leafText(xml, value);
  if (!index || !/^\d+$/u.test(index)) throw new Error("office_target_ambiguous");
  const stringsPart = related(pkg, main, "sharedStrings"),
    strings = pkg.xml(stringsPart);
  const item = strings.root.children.filter((n) => n.uri === cell.uri && n.name === "si")[
    Number(index)
  ];
  if (!item) throw new Error("office_target_ambiguous");
  return {
    part: stringsPart,
    xml: strings,
    nodes: wordText(item),
    shared: { part, xml, node: value, item },
  };
}

function ppt(pkg: OfficePackage, locator: OfficeLocator): Located {
  if (locator.kind !== "powerpoint_shape" && locator.kind !== "powerpoint_placeholder")
    throw new Error("office_target_ambiguous");
  const main = pkg.mainPart(),
    presentation = pkg.xml(main);
  const list = presentation.root.children.find(
    (n) => n.name === "sldIdLst" && n.uri === presentation.root.uri,
  );
  const item = list?.children.filter((n) => n.name === "sldId" && n.uri === list.uri)[
    locator.slide - 1
  ];
  const id = item && relId(item);
  if (!id) throw new Error("office_target_ambiguous");
  const part = related(pkg, main, "slide", id),
    xml = pkg.xml(part);
  const shape = single(
    Array.from(elements(xml.root)).filter((n) => {
      if (
        n.uri !== xml.root.uri ||
        !["sp", "pic", "graphicFrame", "cxnSp", "grpSp"].includes(n.name)
      )
        return false;
      const nv = n.children.find((p) => p.uri === n.uri && p.name.startsWith("nv"));
      if (!nv) return false;
      if (locator.kind === "powerpoint_shape")
        return nv.children.some(
          (p) =>
            p.uri === n.uri && p.name === "cNvPr" && p.attrs.get("id") === String(locator.shapeId),
        );
      const wanted = placeholderTypes[locator.type.toLowerCase()] ?? [locator.type];
      return Array.from(elements(nv)).some(
        (p) =>
          p.uri === n.uri &&
          p.name === "ph" &&
          wanted.includes((p.attrs.get("type") ?? "obj").toLowerCase()),
      );
    }),
  );
  // Group locators must not silently operate on one of the group's independently addressable children.
  const bodies = shape.children.filter(
    (n) => n.uri === shape.uri && (n.name === "txBody" || n.name === "graphic"),
  );
  return {
    part,
    xml,
    nodes: bodies.flatMap((body) =>
      Array.from(elements(body)).filter((n) => drawings.has(n.uri) && n.name === "t"),
    ),
  };
}

export function locate(pkg: OfficePackage, format: OfficeFormat, locator: OfficeLocator) {
  if (format === "docx") return word(pkg, locator);
  if (format === "xlsx") return excel(pkg, locator);
  return ppt(pkg, locator);
}
