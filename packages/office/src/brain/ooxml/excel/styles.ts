import type { ExcelStyle } from "@pibot/protocol-base/office-ooxml";
import type { OfficePackage } from "../package.ts";
import { encoder, escapeXml, parsePart } from "../xml.ts";
import { addRelated, book, nextPart, relation } from "./model.ts";
import {
  children,
  insert,
  raw,
  replace,
  SS,
  setChild,
  ss,
  styleOrder,
  tag,
  unique,
  withAttrs,
} from "./xml-edit.ts";

const base = `<styleSheet xmlns="${SS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
function component(name: string, body: string, uri: string) {
  return ss(name, body, {}, uri);
}
export class Styles {
  readonly part: string;
  private readonly pkg: OfficePackage;
  constructor(pkg: OfficePackage) {
    this.pkg = pkg;
    const b = book(pkg),
      rels = pkg.relationships(b.part).filter((r) => r.type.endsWith("/styles"));
    if (rels.length) this.part = relation(pkg, b.part, "styles");
    else {
      this.part = nextPart(pkg, "xl/styles");
      pkg.addPart(
        this.part,
        encoder.encode(base.replaceAll(SS, b.xml.root.uri)),
        "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
      );
      addRelated(pkg, b.part, this.part, "styles");
    }
    const xml = pkg.xml(this.part);
    if (xml.root.name !== "styleSheet" || xml.root.uri !== b.xml.root.uri)
      throw new Error("office_invalid");
  }
  append(collection: string, name: string, value: string) {
    const xml = this.pkg.xml(this.part),
      node = unique(xml.root, collection),
      items = node ? children(node, name) : [];
    if (items.length >= 64000) throw new Error("office_invalid");
    const body = node ? raw(xml, node) : "";
    if (node) {
      const sub = parsePart(encoder.encode(bodyWithNamespace(body, xml.root.uri, node.ns)));
      const changed = insert(sub, sub.root, value);
      const updated = parsePart(encoder.encode(changed));
      this.pkg.replaceXml(
        this.part,
        replace(xml, node, withAttrs(updated, updated.root, { count: items.length + 1 })),
      );
    } else
      this.pkg.replaceXml(
        this.part,
        setChild(xml, collection, ss(collection, value, { count: 1 }, xml.root.uri), styleOrder),
      );
    return items.length;
  }
  private original(collection: string, name: string, id: number) {
    const xml = this.pkg.xml(this.part),
      node = unique(xml.root, collection),
      item = node && children(node, name)[id];
    if (!item) throw new Error("office_invalid");
    return bodyWithNamespace(raw(xml, item), xml.root.uri, item.ns);
  }
  private fragment(
    name: string,
    old: string,
    parts: Record<string, string | undefined>,
    sequence: string[],
  ) {
    let xml = parsePart(encoder.encode(old));
    for (const [key, value] of Object.entries(parts)) {
      if (value === undefined) continue;
      xml = parsePart(encoder.encode(setChild(xml, key, value, sequence)));
    }
    if (xml.root.name !== name) throw new Error("office_invalid");
    return xml.source;
  }
  private font(style: NonNullable<ExcelStyle["font"]>, old?: string) {
    const uri = this.pkg.xml(this.part).root.uri;
    const boolean = (name: string, value: boolean | undefined) =>
      value === undefined ? undefined : ss(name, "", { val: value }, uri);
    return this.fragment(
      "font",
      old ?? ss("font", "", {}, uri),
      {
        scheme: style.name === undefined ? undefined : "",
        name: style.name === undefined ? undefined : ss("name", "", { val: style.name }, uri),
        sz: style.size === undefined ? undefined : ss("sz", "", { val: style.size }, uri),
        b: boolean("b", style.bold),
        i: boolean("i", style.italic),
        u:
          style.underline === undefined
            ? undefined
            : ss("u", "", { val: style.underline ? "single" : "none" }, uri),
        color:
          style.color === undefined ? undefined : ss("color", "", { rgb: `FF${style.color}` }, uri),
      },
      [
        "name",
        "charset",
        "family",
        "b",
        "i",
        "strike",
        "outline",
        "shadow",
        "condense",
        "extend",
        "color",
        "sz",
        "u",
        "vertAlign",
        "scheme",
      ],
    );
  }
  private border(style: NonNullable<ExcelStyle["border"]>, old?: string) {
    const uri = this.pkg.xml(this.part).root.uri;
    return this.fragment(
      "border",
      old ?? ss("border", "", {}, uri),
      Object.fromEntries(
        Object.entries(style).map(([side, value]) => [
          side,
          ss(
            side,
            value.color ? tag("color", "", { rgb: `FF${value.color}` }) : "",
            { style: value.style },
            uri,
          ),
        ]),
      ),
      ["start", "end", "left", "right", "top", "bottom", "diagonal", "vertical", "horizontal"],
    );
  }
  private fill(color: string) {
    const uri = this.pkg.xml(this.part).root.uri;
    return component(
      "fill",
      tag(
        "patternFill",
        tag("fgColor", "", { rgb: `FF${color}` }) + tag("bgColor", "", { indexed: 64 }),
        { patternType: "solid" },
      ),
      uri,
    );
  }
  style(id: number, style: ExcelStyle) {
    const original = this.original("cellXfs", "xf", id);
    let xml = parsePart(encoder.encode(original));
    const updates: Record<string, number | string> = {};
    if (style.font) {
      updates.fontId = this.append(
        "fonts",
        "font",
        this.font(
          style.font,
          this.original("fonts", "font", Number(xml.root.attrs.get("fontId") ?? 0)),
        ),
      );
      updates.applyFont = 1;
    }
    if (style.fill) {
      updates.fillId = this.append("fills", "fill", this.fill(style.fill));
      updates.applyFill = 1;
    }
    if (style.border) {
      updates.borderId = this.append(
        "borders",
        "border",
        this.border(
          style.border,
          this.original("borders", "border", Number(xml.root.attrs.get("borderId") ?? 0)),
        ),
      );
      updates.applyBorder = 1;
    }
    if (style.numberFormat) {
      const current = this.pkg.xml(this.part),
        fmts = unique(current.root, "numFmts"),
        items = fmts ? children(fmts, "numFmt") : [];
      const found = items.find((n) => n.attrs.get("formatCode") === style.numberFormat);
      let numFmtId = Number(found?.attrs.get("numFmtId"));
      if (!found) {
        numFmtId = Math.max(163, ...items.map((n) => Number(n.attrs.get("numFmtId")))) + 1;
        if (!Number.isFinite(numFmtId) || numFmtId > 65535) throw new Error("office_invalid");
        this.append(
          "numFmts",
          "numFmt",
          ss("numFmt", "", { numFmtId, formatCode: style.numberFormat }, xml.root.uri),
        );
      }
      updates.numFmtId = numFmtId;
      updates.applyNumberFormat = 1;
    }
    if (style.alignment) {
      const existing = unique(xml.root, "alignment"),
        alignment = existing
          ? withAttrs(xml, existing, style.alignment)
          : ss("alignment", "", style.alignment, xml.root.uri);
      xml = parsePart(
        encoder.encode(
          setChild(xml, "alignment", alignment, ["alignment", "protection", "extLst"]),
        ),
      );
      updates.applyAlignment = 1;
    }
    return this.append("cellXfs", "xf", withAttrs(xml, xml.root, updates));
  }
  differential(style: ExcelStyle) {
    if (style.alignment || style.border || style.numberFormat)
      throw new Error("office_unsupported");
    const uri = this.pkg.xml(this.part).root.uri;
    return this.append(
      "dxfs",
      "dxf",
      ss(
        "dxf",
        (style.font ? this.font(style.font) : "") +
          (style.fill
            ? ss(
                "fill",
                tag("patternFill", tag("bgColor", "", { rgb: `FF${style.fill}` }), {
                  patternType: "solid",
                }),
                {},
                uri,
              )
            : ""),
        {},
        uri,
      ),
    );
  }
}
// Standalone source fragments retain inherited prefix bindings, including extension attributes.
function bodyWithNamespace(source: string, uri: string, bindings?: ReadonlyMap<string, string>) {
  const xmlBindings = new Map(bindings ?? [["", uri]]);
  if (!xmlBindings.has("")) xmlBindings.set("", uri);
  const end = source.search(/[\s/>]/u);
  const injected = Array.from(xmlBindings)
    .filter(([prefix]) => prefix !== "xml")
    .filter(
      ([prefix]) =>
        !new RegExp(`\\sxmlns${prefix ? `:${prefix}` : ""}=`, "u").test(
          source.slice(0, source.indexOf(">")),
        ),
    )
    .map(([prefix, value]) => ` xmlns${prefix ? `:${prefix}` : ""}="${escapeXml(value)}"`)
    .join("");
  return source.slice(0, end) + injected + source.slice(end);
}
