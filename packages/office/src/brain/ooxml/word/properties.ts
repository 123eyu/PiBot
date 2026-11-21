import type { Element, XmlPart } from "../xml.ts";
import type { WordDocument } from "./document.ts";

const propertyOrder: Record<string, string[]> = {
  rPr: [
    "rStyle",
    "rFonts",
    "b",
    "bCs",
    "i",
    "iCs",
    "caps",
    "smallCaps",
    "strike",
    "dstrike",
    "outline",
    "shadow",
    "emboss",
    "imprint",
    "noProof",
    "snapToGrid",
    "vanish",
    "webHidden",
    "color",
    "spacing",
    "w",
    "kern",
    "position",
    "sz",
    "szCs",
    "highlight",
    "u",
    "effect",
    "bdr",
    "shd",
    "fitText",
    "vertAlign",
    "rtl",
    "cs",
    "em",
    "lang",
    "eastAsianLayout",
    "specVanish",
    "oMath",
    "rPrChange",
  ],
  pPr: [
    "pStyle",
    "keepNext",
    "keepLines",
    "pageBreakBefore",
    "framePr",
    "widowControl",
    "numPr",
    "suppressLineNumbers",
    "pBdr",
    "shd",
    "tabs",
    "suppressAutoHyphens",
    "kinsoku",
    "wordWrap",
    "overflowPunct",
    "topLinePunct",
    "autoSpaceDE",
    "autoSpaceDN",
    "bidi",
    "adjustRightInd",
    "snapToGrid",
    "spacing",
    "ind",
    "contextualSpacing",
    "mirrorIndents",
    "suppressOverlap",
    "jc",
    "textDirection",
    "textAlignment",
    "textboxTightWrap",
    "outlineLvl",
    "divId",
    "cnfStyle",
    "rPr",
    "sectPr",
    "pPrChange",
  ],
  sectPr: [
    "headerReference",
    "footerReference",
    "footnotePr",
    "endnotePr",
    "type",
    "pgSz",
    "pgMar",
    "paperSrc",
    "pgBorders",
    "lnNumType",
    "pgNumType",
    "cols",
    "formProt",
    "vAlign",
    "noEndnote",
    "titlePg",
    "textDirection",
    "bidi",
    "rtlGutter",
    "docGrid",
    "printerSettings",
    "sectPrChange",
  ],
  tblPr: [
    "tblStyle",
    "tblpPr",
    "tblOverlap",
    "bidiVisual",
    "tblStyleRowBandSize",
    "tblStyleColBandSize",
    "tblW",
    "jc",
    "tblCellSpacing",
    "tblInd",
    "tblBorders",
    "shd",
    "tblLayout",
    "tblCellMar",
    "tblLook",
    "tblCaption",
    "tblDescription",
    "tblPrChange",
  ],
  trPr: [
    "cnfStyle",
    "divId",
    "gridBefore",
    "gridAfter",
    "wBefore",
    "wAfter",
    "cantSplit",
    "trHeight",
    "tblHeader",
    "tblCellSpacing",
    "jc",
    "hidden",
    "ins",
    "del",
    "trPrChange",
  ],
  tcPr: [
    "cnfStyle",
    "tcW",
    "gridSpan",
    "hMerge",
    "vMerge",
    "tcBorders",
    "shd",
    "noWrap",
    "tcMar",
    "textDirection",
    "tcFitText",
    "vAlign",
    "hideMark",
    "tcPrChange",
  ],
};

export function propertyValue(
  d: WordDocument,
  xml: XmlPart,
  node: Element,
  kind: string,
  changes: Record<string, string>,
) {
  const old = d.child(node, kind),
    order = propertyOrder[kind] ?? [];
  if (!old || old.closeStart === old.end) {
    const values = Object.entries(changes)
      .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
      .map(([, v]) => v)
      .join("");
    if (!old) return d.tag(kind, {}, values);
    const raw = d.raw(xml, old),
      name = /^<([^\s/>]+)/u.exec(raw)?.[1];
    return `${raw.slice(0, -2)}>${values}</${name}>`;
  }
  const edits: { start: number; end: number; value: string }[] = [],
    inserts = new Map<number, string[]>();
  for (const [name, value] of Object.entries(changes).sort(
    ([a], [b]) => order.indexOf(a) - order.indexOf(b),
  )) {
    const matches = old.children.filter((n) => n.uri === d.uri && n.name === name);
    if (matches.length > 1) throw new Error("office_target_ambiguous");
    if (matches[0]) {
      edits.push({ start: matches[0].start, end: matches[0].end, value });
      continue;
    }
    if (!value) continue;
    const rank = order.indexOf(name),
      at =
        old.children.find((n) => n.uri !== d.uri || (rank >= 0 && order.indexOf(n.name) > rank))
          ?.start ?? old.closeStart;
    const values = inserts.get(at) ?? [];
    values.push(value);
    inserts.set(at, values);
  }
  for (const [start, values] of inserts) edits.push({ start, end: start, value: values.join("") });
  let raw = d.raw(xml, old);
  for (const e of edits.sort((a, b) => b.start - a.start || b.end - a.end))
    raw = raw.slice(0, e.start - old.start) + e.value + raw.slice(e.end - old.start);
  return raw;
}
