import { one } from "../locate.ts";
import { DOC_REL, STRICT_REL } from "../package.ts";
import { encoder, parsePart } from "../xml.ts";
import { W, type WordDocument, type WordOperation } from "./document.ts";

export function formatWord(d: WordDocument, op: Extract<WordOperation, { op: "word_format" }>) {
  const t = d.target(op.locator),
    changes: Record<string, string> = {};
  const props = parsePart(encoder.encode(d.tag("rPr", {}, d.format(op.format))));
  for (const p of props.root.children) changes[p.name] = d.raw(props, p);
  const runs = d
    .all(t.xml, "r")
    .filter((r) => t.nodes.some((n) => n.start >= r.openEnd && n.end <= r.closeStart));
  if (
    !runs.length ||
    runs.some((r) =>
      r.children.some((n) => n.uri === d.uri && ["fldChar", "instrText"].includes(n.name)),
    )
  )
    throw new Error("office_unsupported");
  const rel =
    op.link && !op.link.startsWith("#") ? d.relationship(op.link, "hyperlink", true) : undefined;
  const edits = runs.map((r) => {
    let value = d.withProps(t.xml, r, "rPr", changes);
    if (op.link) {
      if (!t.paragraphs.some((p) => p.children.includes(r))) throw new Error("office_unsupported");
      value = rel
        ? d
            .tag("hyperlink", {}, value)
            .replace(
              " xmlns:w=",
              ` xmlns:r="${d.uri.endsWith("/2006/main") ? DOC_REL : STRICT_REL}" r:id="${rel}" xmlns:w=`,
            )
        : d.tag("hyperlink", { anchor: op.link.slice(1) }, value);
    }
    return { start: r.start, end: r.end, value };
  });
  // Relationship creation changes only .rels, so the document source spans stay valid.
  d.patch(t.part, t.xml, edits);
}
function numbering(d: WordDocument, key: string, ordered: boolean) {
  const part = d.part("numbering", "numbering"),
    xml = d.pkg.xml(part);
  const matches = d.all(xml, "abstractNum").filter((n) => {
    const name = d.child(n, "name");
    return name && d.attr(name, "val") === `PiBot:${key}`;
  });
  if (matches.length) {
    const abstract = one(matches),
      id = d.attr(abstract, "abstractNumId");
    const nums = d.all(xml, "num").filter((n) => {
      const parent = d.child(n, "abstractNumId");
      return parent && d.attr(parent, "val") === id;
    });
    const firstLevel = d.child(abstract, "lvl"),
      format = firstLevel && d.child(firstLevel, "numFmt");
    if (!format || d.attr(format, "val") !== (ordered ? "decimal" : "bullet"))
      throw new Error("office_target_ambiguous");
    const num = one(nums);
    const numId = d.attr(num, "numId");
    if (!numId) throw new Error("office_invalid");
    return numId;
  }
  const abstract = d.nextId(["abstractNum"], [part]),
    num = d.nextId(["num"], [part]);
  let levels = "";
  for (let level = 0; level < 9; level++)
    levels += d.tag(
      "lvl",
      { ilvl: level },
      d.tag("start", { val: 1 }) +
        d.tag("numFmt", { val: ordered ? "decimal" : "bullet" }) +
        d.tag("lvlText", {
          val: ordered
            ? `${Array.from({ length: level + 1 }, (_, i) => `%${i + 1}`).join(".")}.`
            : "•",
        }) +
        d.tag("lvlJc", { val: d.alignment("left") }) +
        d.tag(
          "pPr",
          {},
          d.tag("tabs", {}, d.tag("tab", { val: "num", pos: 720 * (level + 1) })) +
            d.tag("ind", { [d.uri === W ? "left" : "start"]: 720 * (level + 1), hanging: 360 }),
        ),
    );
  const definition = d.tag(
    "abstractNum",
    { abstractNumId: abstract },
    d.tag("multiLevelType", { val: "multilevel" }) +
      d.tag("name", { val: `PiBot:${key}` }) +
      levels,
  );
  const firstNum = d.all(xml, "num")[0];
  // abstractNum must precede num in the numbering schema.
  const at =
    firstNum?.start ?? d.child(xml.root, "numIdMacAtCleanup")?.start ?? xml.root.closeStart;
  if (xml.root.closeStart === xml.root.end)
    d.insert(
      part,
      xml,
      xml.root,
      definition + d.tag("num", { numId: num }, d.tag("abstractNumId", { val: abstract })),
    );
  else {
    d.patch(part, xml, [{ start: at, end: at, value: definition }]);
    const next = d.pkg.xml(part);
    const numAt = d.child(next.root, "numIdMacAtCleanup")?.start ?? next.root.closeStart;
    d.patch(part, next, [
      {
        start: numAt,
        end: numAt,
        value: d.tag("num", { numId: num }, d.tag("abstractNumId", { val: abstract })),
      },
    ]);
  }
  return String(num);
}
export function paragraphWord(
  d: WordDocument,
  op: Extract<WordOperation, { op: "word_paragraph" }>,
) {
  const t = d.paragraph(op.locator),
    changes: Record<string, string> = {};
  if (op.style && ["Quote", "Code"].includes(op.style)) {
    const styles = d.related("styles"),
      exists =
        styles && d.all(d.pkg.xml(styles), "style").some((n) => d.attr(n, "styleId") === op.style);
    if (!exists)
      styleWord(d, {
        op: "word_style",
        id: op.style,
        name: op.style,
        basedOn: "Normal",
        format: op.style === "Quote" ? { italic: true } : { font: "Courier New", size: 20 },
      });
  }
  if (op.style) changes.pStyle = d.tag("pStyle", { val: op.style });
  if (op.align) changes.jc = d.tag("jc", { val: d.alignment(op.align) });
  if (op.list)
    changes.numPr = d.tag(
      "numPr",
      {},
      d.tag("ilvl", { val: op.list.level }) +
        d.tag("numId", { val: numbering(d, op.list.key, op.list.ordered) }),
    );
  d.props(t.part, t.xml, t.paragraph, "pPr", changes);
}
export function styleWord(d: WordDocument, op: Extract<WordOperation, { op: "word_style" }>) {
  const part = d.part("styles", "styles"),
    xml = d.pkg.xml(part),
    matches = d.all(xml, "style").filter((n) => d.attr(n, "styleId") === op.id);
  if (matches.length > 1) throw new Error("office_target_ambiguous");
  const value = d.tag(
    "style",
    { type: "paragraph", customStyle: "1", styleId: op.id },
    d.tag("name", { val: op.name }) +
      (op.basedOn ? d.tag("basedOn", { val: op.basedOn }) : "") +
      (op.next ? d.tag("next", { val: op.next }) : "") +
      d.tag("qFormat") +
      (op.outlineLevel === undefined
        ? ""
        : d.tag("pPr", {}, d.tag("outlineLvl", { val: op.outlineLevel }))) +
      d.tag("rPr", {}, d.format(op.format)),
  );
  // Overwriting unknown existing style properties would damage imported documents.
  if (matches.length) throw new Error("office_target_ambiguous");
  d.insert(part, xml, xml.root, value);
}
