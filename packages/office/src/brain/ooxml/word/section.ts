import { one } from "../locate.ts";
import { DOC_REL, STRICT_REL } from "../package.ts";
import { encoder } from "../xml.ts";
import type { WordDocument, WordOperation } from "./document.ts";

export function sectionWord(d: WordDocument, op: Extract<WordOperation, { op: "word_section" }>) {
  const xml = d.pkg.xml(d.main),
    body = d.body(xml),
    changes: Record<string, string> = {};
  if (op.page.type) changes.type = d.tag("type", { val: op.page.type });
  const existing = op.locator ? undefined : d.child(body, "sectPr");
  if (op.page.width !== undefined || op.page.height !== undefined || op.page.orientation) {
    const size = existing && d.child(existing, "pgSz");
    let width = Number(op.page.width ?? (size && d.attr(size, "w")) ?? 11906),
      height = Number(op.page.height ?? (size && d.attr(size, "h")) ?? 16838);
    if (
      op.page.orientation &&
      op.page.width === undefined &&
      op.page.height === undefined &&
      ((op.page.orientation === "landscape" && width < height) ||
        (op.page.orientation === "portrait" && width > height))
    )
      [width, height] = [height, width];
    changes.pgSz = d.tag("pgSz", {
      w: width,
      h: height,
      orient: op.page.orientation ?? (size && d.attr(size, "orient")) ?? "portrait",
    });
  }
  if (op.page.margin)
    changes.pgMar = d.tag("pgMar", { ...op.page.margin, header: 720, footer: 720, gutter: 0 });
  if (op.locator) {
    const t = d.paragraph(op.locator),
      ppr = d.child(t.paragraph, "pPr"),
      old = ppr && d.child(ppr, "sectPr");
    const value =
      old && ppr
        ? d.propertyValue(t.xml, ppr, "sectPr", changes)
        : d.tag("sectPr", {}, Object.values(changes).join(""));
    d.props(t.part, t.xml, t.paragraph, "pPr", { sectPr: value });
  } else if (existing)
    d.replace(d.main, xml, existing, d.propertyValue(xml, body, "sectPr", changes));
  else d.insert(d.main, xml, body, d.tag("sectPr", {}, Object.values(changes).join("")));
}
export function headerFooter(
  d: WordDocument,
  op: Extract<WordOperation, { op: "word_header_footer" }>,
) {
  let xml = d.pkg.xml(d.main),
    sections = d.all(xml, "sectPr"),
    section = sections[op.section - 1];
  if (!section && op.section === 1 && sections.length === 0) {
    sectionWord(d, { op: "word_section", page: {} });
    xml = d.pkg.xml(d.main);
    sections = d.all(xml, "sectPr");
    section = sections[0];
  }
  if (!section) throw new Error("office_target_ambiguous");
  const suffix = op.position,
    reference = `${suffix}Reference`,
    rels = d.pkg.relationships(d.main);
  const refs = section.children.filter(
    (n) => n.uri === d.uri && n.name === reference && d.attr(n, "type") === op.variant,
  );
  if (refs.length > 1) throw new Error("office_target_ambiguous");
  const current = refs[0],
    relId = current && Array.from(current.attrs).find(([k]) => k.endsWith(":id"))?.[1];
  const related = relId
    ? one(rels.filter((r) => r.id === relId && !r.external && r.type.endsWith(`/${suffix}`)))
    : undefined;
  // A referenced header may be shared by other sections. Always create a private part for this section.
  void related;
  let n = 1,
    part: string;
  do {
    part = d.main.replace(/[^/]+$/u, `${suffix}PiBot${n++}.xml`);
  } while (d.pkg.has(part));
  const field = op.pageNumber ? d.tag("fldSimple", { instr: " PAGE " }, d.run("1")) : "";
  d.pkg.addPart(
    part,
    encoder.encode(
      d.tag(suffix === "header" ? "hdr" : "ftr", {}, d.tag("p", {}, d.run(op.text) + field)),
    ),
    `application/vnd.openxmlformats-officedocument.wordprocessingml.${suffix}+xml`,
  );
  const id = d.relationship(part, suffix),
    value = d
      .tag(reference, { type: op.variant })
      .replace(
        " xmlns:w=",
        ` xmlns:r="${d.uri.endsWith("/2006/main") ? DOC_REL : STRICT_REL}" r:id="${id}" xmlns:w=`,
      );
  if (current) d.replace(d.main, xml, current, value);
  else {
    const at =
      section.children.find(
        (c) =>
          c.name !== "headerReference" && (suffix === "header" || c.name !== "footerReference"),
      )?.start ?? section.closeStart;
    if (section.closeStart === section.end) d.insert(d.main, xml, section, value);
    else d.patch(d.main, xml, [{ start: at, end: at, value }]);
  }
  if (op.variant === "first") {
    const next = d.pkg.xml(d.main),
      s = one(d.all(next, "sectPr").slice(op.section - 1, op.section));
    const tag = d.tag("titlePg");
    const after = s.children.find((c) =>
      ["textDirection", "bidi", "rtlGutter", "docGrid", "sectPrChange"].includes(c.name),
    );
    const at = after?.start ?? s.closeStart;
    if (!d.child(s, "titlePg")) {
      if (s.closeStart === s.end) d.insert(d.main, next, s, tag);
      else d.patch(d.main, next, [{ start: at, end: at, value: tag }]);
    }
  }
  if (op.variant === "even") setting(d, "evenAndOddHeaders");
}
export function setting(d: WordDocument, name: "evenAndOddHeaders" | "updateFields") {
  const part = d.part("settings", "settings"),
    xml = d.pkg.xml(part),
    old = d.child(xml.root, name),
    value = d.tag(name, { val: "true" });
  if (old) {
    d.replace(part, xml, old, value);
    return;
  }
  // Settings is an ordered sequence; extension and compatibility settings must remain after these flags.
  const afterEven = new Set([
    "bookFoldRevPrinting",
    "bookFoldPrinting",
    "bookFoldPrintingSheets",
    "drawingGridHorizontalSpacing",
    "drawingGridVerticalSpacing",
    "displayHorizontalDrawingGridEvery",
    "displayVerticalDrawingGridEvery",
    "doNotUseMarginsForDrawingGridOrigin",
    "drawingGridHorizontalOrigin",
    "drawingGridVerticalOrigin",
    "doNotShadeFormData",
    "noPunctuationKerning",
    "characterSpacingControl",
    "printTwoOnOne",
    "strictFirstAndLastChars",
    "noLineBreaksAfter",
    "noLineBreaksBefore",
    "savePreviewPicture",
    "doNotValidateAgainstSchema",
    "saveInvalidXml",
    "ignoreMixedContent",
    "alwaysShowPlaceholderText",
    "doNotDemarcateInvalidXml",
    "saveXmlDataOnly",
    "useXSLTWhenSaving",
    "saveThroughXslt",
    "showXMLTags",
    "alwaysMergeEmptyNamespace",
    "updateFields",
  ]);
  const afterUpdate = new Set([
    "hdrShapeDefaults",
    "footnotePr",
    "endnotePr",
    "compat",
    "docVars",
    "rsids",
    "attachedSchema",
    "themeFontLang",
    "clrSchemeMapping",
    "doNotIncludeSubdocsInStats",
    "doNotAutoCompressPictures",
    "forceUpgrade",
    "captions",
    "readModeInkLockDown",
    "smartTagType",
    "shapeDefaults",
    "doNotEmbedSmartTags",
    "decimalSymbol",
    "listSeparator",
  ]);
  const at =
    xml.root.children.find(
      (n) =>
        n.uri !== d.uri ||
        afterUpdate.has(n.name) ||
        (name === "evenAndOddHeaders" && afterEven.has(n.name)),
    )?.start ?? xml.root.closeStart;
  if (xml.root.closeStart === xml.root.end) d.insert(part, xml, xml.root, value);
  else d.patch(part, xml, [{ start: at, end: at, value }]);
}
export function toc(d: WordDocument, op: Extract<WordOperation, { op: "word_toc" }>) {
  const t = d.paragraph(op.locator);
  const value = d.tag(
    "p",
    {},
    d.tag("r", {}, d.tag("fldChar", { fldCharType: "begin", dirty: "true" })) +
      d.tag(
        "r",
        {},
        d
          .tag("instrText", {}, ` TOC \\o &quot;1-${op.levels}&quot; \\h \\z \\u `)
          .replace(" xmlns:w=", ' xml:space="preserve" xmlns:w='),
      ) +
      d.tag("r", {}, d.tag("fldChar", { fldCharType: "separate" })) +
      d.run("打开后更新目录 / Update this table of contents after opening") +
      d.tag("r", {}, d.tag("fldChar", { fldCharType: "end" })),
  );
  d.patch(t.part, t.xml, [{ start: t.paragraph.end, end: t.paragraph.end, value }]);
  setting(d, "updateFields");
}
