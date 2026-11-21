import type { ExcelOperation } from "@pibot/protocol-base/office-ooxml";
import type { OfficePackage } from "../package.ts";
import type { Element, XmlPart } from "../xml.ts";
import { children, raw, setChild, ss, unique, withAttrs } from "./xml-edit.ts";

type Dimensions = Extract<ExcelOperation, { op: "excel_dimensions" }>;
export function columns(
  pkg: OfficePackage,
  part: string,
  updates: NonNullable<Dimensions["columns"]>,
) {
  const xml = pkg.xml(part);
  const root = unique(xml.root, "cols");
  const grid = columnGrid(root);
  for (const dim of updates) {
    if (dim.first > dim.last) throw new Error("office_invalid");
    for (let c = dim.first; c <= dim.last; c++) grid.set(c, { ...grid.get(c), width: dim.width });
  }
  const runs = coalesce(xml, grid);
  const body = runs
    .map((item) =>
      item.node
        ? withAttrs(xml, item.node, {
            min: item.first,
            max: item.last,
            ...(item.width === undefined ? {} : { width: item.width, customWidth: 1 }),
          })
        : ss(
            "col",
            "",
            { min: item.first, max: item.last, width: item.width, customWidth: 1 },
            xml.root.uri,
          ),
    )
    .join("");
  pkg.replaceXml(
    part,
    setChild(
      xml,
      "cols",
      root
        ? withAttrs(
            xml,
            root,
            {},
            body +
              root.children
                .filter((n) => n.uri !== root.uri || n.name !== "col")
                .map((n) => raw(xml, n))
                .join(""),
          )
        : ss("cols", body, {}, xml.root.uri),
    ),
  );
}

function coalesce(xml: XmlPart, grid: Map<number, { node?: Element; width?: number }>) {
  const runs: {
    first: number;
    last: number;
    node?: Element;
    width?: number;
    key: string;
  }[] = [];
  for (const [c, item] of Array.from(grid).sort(([a], [b]) => a - b)) {
    const attributes = new Map(item.node?.attrs);
    attributes.delete("min");
    attributes.delete("max");
    if (item.width !== undefined) {
      attributes.set("width", String(item.width));
      attributes.set("customWidth", "1");
    }
    const key = JSON.stringify([
      Array.from(attributes).sort(([a], [b]) => a.localeCompare(b)),
      Array.from(item.node?.ns ?? xml.root.ns),
      item.node
        ? xml.source.slice(
            item.node.openEnd,
            item.node.closeStart === item.node.end ? item.node.openEnd : item.node.closeStart,
          )
        : "",
    ]);
    const previous = runs.at(-1);
    if (previous && previous.last + 1 === c && previous.key === key) previous.last = c;
    else runs.push({ first: c, last: c, ...item, key });
  }
  return runs;
}

function columnGrid(root: Element | undefined) {
  const segments = (root ? children(root, "col") : []).map((n) => ({
    first: Number(n.attrs.get("min")),
    last: Number(n.attrs.get("max")),
    node: n,
  }));
  for (const s of segments)
    if (
      !Number.isInteger(s.first) ||
      !Number.isInteger(s.last) ||
      s.first < 1 ||
      s.last > 16384 ||
      s.first > s.last
    )
      throw new Error("office_invalid");
  segments.sort((a, b) => a.first - b.first);
  for (let i = 1; i < segments.length; i++)
    if ((segments[i - 1]?.last ?? 0) >= (segments[i]?.first ?? 0))
      throw new Error("office_target_ambiguous");
  // Expand only the finite column grid; retain every unrelated column attribute.
  const grid = new Map<number, { node?: Element; width?: number }>();
  for (const s of segments) for (let c = s.first; c <= s.last; c++) grid.set(c, { node: s.node });
  return grid;
}
