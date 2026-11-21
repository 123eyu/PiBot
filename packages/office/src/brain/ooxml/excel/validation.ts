import type { ExcelOperation } from "@pibot/protocol-base/office-ooxml";
import type { OfficePackage } from "../package.ts";
import { escapeXml } from "../xml.ts";
import { area, book, overlaps, sheetPart } from "./model.ts";
import { definedName, tableNames } from "./names.ts";
import { Styles } from "./styles.ts";
import { children, replace, setChild, ss, tag, unique, withAttrs } from "./xml-edit.ts";

function checkBounds(operator: string, values: number[]) {
  if (values.length !== (["between", "notBetween"].includes(operator) ? 2 : 1))
    throw new Error("office_invalid");
  if (values.length === 2 && (values[0] ?? 0) > (values[1] ?? 0)) throw new Error("office_invalid");
}
export function conditional(
  pkg: OfficePackage,
  op: Extract<ExcelOperation, { op: "excel_conditional_format" }>,
) {
  const { part, xml } = sheetPart(pkg, op.sheet),
    a = area(op.range),
    r = op.rule;
  let body: string;
  if (r.kind === "cellIs") {
    checkBounds(r.operator, r.values);
    const styles = new Styles(pkg),
      dxfId = styles.differential(r.style);
    body = tag("cfRule", r.values.map((v) => tag("formula", String(v))).join(""), {
      type: "cellIs",
      operator: r.operator,
      dxfId,
    });
  } else if (r.kind === "dataBar")
    body = tag(
      "cfRule",
      tag(
        "dataBar",
        tag("cfvo", "", { type: "min" }) +
          tag("cfvo", "", { type: "max" }) +
          tag("color", "", { rgb: `FF${r.color}` }),
      ),
      { type: "dataBar" },
    );
  else
    body = tag(
      "cfRule",
      tag(
        "colorScale",
        (r.colors.length === 2
          ? [tag("cfvo", "", { type: "min" }), tag("cfvo", "", { type: "max" })]
          : [
              tag("cfvo", "", { type: "min" }),
              tag("cfvo", "", { type: "percentile", val: 50 }),
              tag("cfvo", "", { type: "max" }),
            ]
        ).join("") + r.colors.map((c) => tag("color", "", { rgb: `FF${c}` })).join(""),
      ),
      { type: "colorScale" },
    );
  let priority = 0;
  for (const cf of children(xml.root, "conditionalFormatting"))
    for (const rule of children(cf, "cfRule")) {
      const p = Number(rule.attrs.get("priority"));
      if (!Number.isSafeInteger(p) || p < 1 || p >= 100000) throw new Error("office_invalid");
      priority = Math.max(priority, p);
    }
  body = body.replace("<cfRule ", `<cfRule priority="${priority + 1}" `);
  pkg.replaceXml(
    part,
    setChild(
      xml,
      "conditionalFormatting",
      ss("conditionalFormatting", body, { sqref: a.ref }, xml.root.uri),
      undefined,
      true,
    ),
  );
}
export function validation(
  pkg: OfficePackage,
  op: Extract<ExcelOperation, { op: "excel_validation" }>,
) {
  const { part } = sheetPart(pkg, op.sheet),
    a = area(op.range),
    v = op.validation;
  let f1: string, f2: string | undefined, type: string;
  if (v.kind === "list") {
    const list = v.values.join(",");
    if (list.length > 253) throw new Error("office_invalid");
    f1 = `"${list}"`;
    type = "list";
  } else if (v.kind === "listRange") {
    const source = area(v.source.range);
    if (source.firstRow !== source.lastRow && source.firstColumn !== source.lastColumn)
      throw new Error("office_invalid");
    const b = book(pkg),
      names = new Set(
        children(unique(b.xml.root, "definedNames") ?? b.xml.root, "definedName").map((n) =>
          n.attrs.get("name")?.toLowerCase(),
        ),
      );
    for (const name of tableNames(pkg)) names.add(name);
    let i = 1;
    while (names.has(`pibotvalidation${i}`)) i++;
    f1 = `PiBotValidation${i}`;
    definedName(pkg, f1, v.source);
    type = "list";
  } else {
    checkBounds(v.operator, v.values);
    if (v.kind === "whole" && v.values.some((n) => !Number.isInteger(n)))
      throw new Error("office_invalid");
    f1 = String(v.values[0]);
    f2 = v.values[1] === undefined ? undefined : String(v.values[1]);
    type = v.kind;
  }
  const xml = pkg.xml(part),
    parent = unique(xml.root, "dataValidations"),
    items = parent ? children(parent, "dataValidation") : [];
  for (const item of items)
    for (const old of (item.attrs.get("sqref") ?? "").split(/\s+/u))
      if (overlaps(a, area(old, Number.MAX_SAFE_INTEGER)))
        throw new Error("office_target_ambiguous");
  const body = ss(
    "dataValidation",
    tag("formula1", escapeXml(f1)) + (f2 === undefined ? "" : tag("formula2", escapeXml(f2))),
    {
      type,
      sqref: a.ref,
      operator: "operator" in v ? v.operator : undefined,
      allowBlank: op.allowBlank,
      showErrorMessage: true,
      errorStyle: "stop",
      errorTitle: op.errorTitle,
      error: op.error,
    },
    xml.root.uri,
  );
  pkg.replaceXml(
    part,
    parent
      ? replace(
          xml,
          parent,
          withAttrs(
            xml,
            parent,
            { count: items.length + 1 },
            xml.source.slice(parent.openEnd, parent.closeStart) + body,
          ),
        )
      : setChild(xml, "dataValidations", ss("dataValidations", body, { count: 1 }, xml.root.uri)),
  );
}
