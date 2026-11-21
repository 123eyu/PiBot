import { type OfficePackage, relationshipSource } from "../package.ts";
import { attribute, type Element, elements, encoder } from "../xml.ts";
import { anchor } from "./chart-anchor.ts";
import { chartXml } from "./chart-space.ts";
import { A, C, type ChartOp, R, XDR } from "./chart-xml.ts";
import { addRelated, book, nextPart, relation, sheetPart } from "./model.ts";
import { insert, replace, SS, setChild, ss, tag, unique } from "./xml-edit.ts";

export function chart(pkg: OfficePackage, op: ChartOp) {
  // New drawing markup is transitional; do not silently mix it into strict workbooks.
  if (book(pkg).xml.root.uri !== SS) throw new Error("office_unsupported");
  const source = chartXml(pkg, op.chart),
    drawing = drawingPart(pkg, op);
  const draw = pkg.xml(drawing);
  if (draw.root.name !== "wsDr" || draw.root.uri !== XDR) throw new Error("office_unsupported");
  const all = Array.from(elements(draw.root)),
    named = all.filter(
      (n) => n.uri === XDR && n.name === "cNvPr" && n.attrs.get("name") === op.name,
    );
  if (named.length > 1) throw new Error("office_target_ambiguous");
  let oldAnchor: typeof draw.root | undefined,
    chartPart: string | undefined,
    relationship: string | undefined;
  let id = nextDrawingId(all);
  if (named[0]) {
    const target = existingChart(pkg, drawing, draw.root, all, named[0]);
    oldAnchor = target.oldAnchor;
    relationship = target.relationship;
    chartPart = target.chartPart;
    id = target.id;
    pkg.replaceXml(chartPart, source);
  } else {
    chartPart = nextPart(pkg, "xl/charts/chart");
    pkg.addPart(
      chartPart,
      encoder.encode(source),
      "application/vnd.openxmlformats-officedocument.drawingml.chart+xml",
    );
    relationship = addRelated(pkg, drawing, chartPart, "chart").id;
  }
  const current = pkg.xml(drawing),
    value = anchor(op, id, relationship);
  pkg.replaceXml(
    drawing,
    oldAnchor ? replace(current, oldAnchor, value) : insert(current, current.root, value),
  );
}

export { chartXml } from "./chart-space.ts";

function drawingPart(pkg: OfficePackage, op: ChartOp) {
  const { part, xml } = sheetPart(pkg, op.sheet),
    drawingNode = unique(xml.root, "drawing");
  let drawing: string;
  if (drawingNode) {
    const id = attribute(drawingNode, "id", R);
    if (!id) throw new Error("office_invalid");
    drawing = relation(pkg, part, "drawing", id);
  } else {
    drawing = nextPart(pkg, "xl/drawings/drawing");
    pkg.addPart(
      drawing,
      encoder.encode(tag("xdr:wsDr", "", { "xmlns:xdr": XDR, "xmlns:a": A })),
      "application/vnd.openxmlformats-officedocument.drawing+xml",
    );
    const rel = addRelated(pkg, part, drawing, "drawing");
    pkg.replaceXml(
      part,
      setChild(
        xml,
        "drawing",
        ss("drawing", "", { "xmlns:r": rel.ns, "r:id": rel.id }, xml.root.uri),
      ),
    );
  }
  return drawing;
}

function assertUnshared(
  pkg: OfficePackage,
  chartPart: string,
  all: Element[],
  relationship: string,
) {
  let references = 0;
  for (const name of pkg.names())
    if (name.endsWith(".rels")) {
      const source = relationshipSource(name);
      if (source === undefined) throw new Error("office_invalid");
      for (const rel of pkg.relationships(source)) if (rel.target === chartPart) references++;
    }
  if (
    references !== 1 ||
    all.filter((n) => n.uri === C && n.name === "chart" && attribute(n, "id", R) === relationship)
      .length !== 1
  )
    throw new Error("office_target_ambiguous");
}

function nextDrawingId(all: Element[]) {
  const used = new Set<number>();
  for (const node of all.filter((n) => n.uri === XDR && n.name === "cNvPr")) {
    const id = Number(node.attrs.get("id"));
    if (!Number.isInteger(id) || id < 1 || id >= 0xffff_ffff || used.has(id))
      throw new Error("office_invalid");
    used.add(id);
  }
  let id = 1;
  for (const value of used) id = Math.max(id, value + 1);
  return id;
}

function existingChart(
  pkg: OfficePackage,
  drawing: string,
  root: Element,
  all: Element[],
  selected: Element,
) {
  const oldAnchor = root.children.find((n) => n.start < selected.start && n.end > selected.end);
  if (!oldAnchor || oldAnchor.uri !== XDR || oldAnchor.name !== "twoCellAnchor")
    throw new Error("office_unsupported");
  if (
    oldAnchor.children.some(
      (n) => n.uri === XDR && ["sp", "pic", "grpSp", "cxnSp", "contentPart"].includes(n.name),
    )
  )
    throw new Error("office_unsupported");
  const refs = Array.from(elements(oldAnchor)).filter((n) => n.uri === C && n.name === "chart");
  if (refs.length !== 1 || !refs[0]) throw new Error("office_target_ambiguous");
  const relationship = attribute(refs[0], "id", R);
  if (!relationship) throw new Error("office_invalid");
  const chartPart = relation(pkg, drawing, "chart", relationship);
  const id = Number(selected.attrs.get("id"));
  assertUnshared(pkg, chartPart, all, relationship);
  return { oldAnchor, relationship, chartPart, id };
}
