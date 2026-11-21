import { posix } from "node:path";
import { type OfficeArchive, packArchive } from "../../codecs/archive.ts";
import { namespaces, tableUris } from "../namespaces.ts";
import { DOC_REL, REL_NS, relationshipPart, resolveTarget, TYPES, TYPES_NS } from "../package.ts";
import { encoder, escapeXml as esc } from "../xml.ts";
import type { Box, Theme } from "./themes.ts";

export const P = namespaces.pptx[0];
export const A = namespaces.drawingml[0];
// The graphicData discriminator is not the namespace of its a:tbl payload.
export const TABLE_URI = tableUris[0];
export const C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
export const ns = `xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${DOC_REL}"`;
export const pptType = (part: string) =>
  `application/vnd.openxmlformats-officedocument.presentationml.${part}+xml`;
export const themeType = "application/vnd.openxmlformats-officedocument.theme+xml";
export const chartType = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
export const workbookType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
type Relation = {
  id: string;
  kind: string;
  target: string;
  external?: boolean;
  namespace?: string;
};

/** Batch serialization keeps new-package assembly linear; OfficePackage validates the candidate. */
export class PresentationParts {
  private readonly entries: OfficeArchive = new Map();
  private readonly types = new Map<string, string>();
  private readonly relations = new Map<string, Relation[]>();
  private readonly media = new Map<string, string>();
  private outputRoot: string | undefined;
  private readonly standard: boolean;
  constructor(standard = true) {
    this.standard = standard;
  }
  get isStandard() {
    return this.standard;
  }
  get root() {
    if (!this.outputRoot) {
      let index = 0;
      let root = this.standard ? "ppt" : "ppt/pibot";
      while ([...this.entries.keys()].some((name) => name.startsWith(`${root}/`)))
        root = `ppt/pibot${++index}`;
      this.outputRoot = root;
    }
    return this.outputRoot;
  }

  part(name: string, type: string, bytes: string | Uint8Array) {
    if (this.entries.has(name) || resolveTarget("", `/${name}`) !== name)
      throw new Error("office_invalid");
    this.entries.set(name, typeof bytes === "string" ? encoder.encode(bytes) : bytes);
    this.types.set(name, type);
  }

  image(key: string, extension: string, contentType: string, bytes: Uint8Array) {
    const existing = this.media.get(key);
    if (existing) return existing;
    const part = `${this.root}/media/image${this.media.size + 1}.${extension}`;
    this.part(part, contentType, bytes);
    this.media.set(key, part);
    return part;
  }

  relate(
    source: string,
    kind: string,
    target: string,
    options?: { id?: string; external?: boolean; namespace?: string },
  ) {
    const list = this.relations.get(source) ?? [];
    const id = options?.id ?? `rId${list.length + 1}`;
    if (options?.id && list.some((rel) => rel.id === id)) throw new Error("office_invalid");
    list.push({ id, kind, target, external: options?.external, namespace: options?.namespace });
    this.relations.set(source, list);
    return id;
  }

  write() {
    for (const [source, rels] of this.relations) {
      const name = relationshipPart(source);
      if ((source && !this.entries.has(source)) || this.entries.has(name))
        throw new Error("office_invalid");
      this.entries.set(name, encoder.encode(relationshipXml(source, rels, this.entries)));
    }
    this.entries.set(TYPES, encoder.encode(contentTypesXml(this.types)));
    return packArchive(this.entries);
  }
}

function relationshipXml(source: string, rels: Relation[], entries: OfficeArchive) {
  const inner = rels.map((relation) => relationship(relation, source, entries)).join("");
  return `<Relationships xmlns="${REL_NS}">${inner}</Relationships>`;
}

function relationship(relation: Relation, source: string, entries: OfficeArchive) {
  const { id, kind, target, external, namespace } = relation;
  if (!external && !entries.has(target)) throw new Error("office_invalid");
  const path = external ? target : relativeTarget(source, target);
  const mode = external ? ' TargetMode="External"' : "";
  return `<Relationship Id="${esc(id)}" Type="${namespace ?? DOC_REL}/${esc(kind)}" Target="${esc(path)}"${mode}/>`;
}

function relativeTarget(source: string, target: string) {
  return posix
    .relative(posix.dirname(source), target)
    .split("/")
    .map((item) => (item === ".." ? item : encodeURIComponent(item)))
    .join("/");
}

function contentTypesXml(types: Map<string, string>) {
  const overrides = Array.from(types, ([name, type]) => contentTypeOverride(name, type)).join("");
  return `<Types xmlns="${TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>${overrides}</Types>`;
}

function contentTypeOverride(name: string, type: string) {
  const path = name.split("/").map(encodeURIComponent).join("/");
  return `<Override PartName="/${esc(path)}" ContentType="${type}"/>`;
}

export const rgb = (hex: string) => `<a:srgbClr val="${hex.toUpperCase()}"/>`;
export const fill = (hex: string) => `<a:solidFill>${rgb(hex)}</a:solidFill>`;
export const bg = (hex: string) => `<p:bg><p:bgPr>${fill(hex)}<a:effectLst/></p:bgPr></p:bg>`;
export const colorMap =
  '<p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/>';
export const colorOverride = "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>";
export const shapeTree = (shapes: string) =>
  `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree>`;
export function transform(box: Box, width: number, height: number, prefix = "a", flip = "") {
  const { x, y, width: w, height: h } = box;
  return `<${prefix}:xfrm${flip}><a:off x="${Math.round(x * width)}" y="${Math.round(y * height)}"/><a:ext cx="${Math.max(1, Math.round(w * width))}" cy="${Math.max(1, Math.round(h * height))}"/></${prefix}:xfrm>`;
}

export function drawingTheme(theme: Theme) {
  const colors = [
    ["dk1", theme.ink],
    ["lt1", theme.background],
    ["dk2", theme.muted],
    ["lt2", theme.paper],
    ...theme.colors.map((color, index) => [`accent${index + 1}`, color]),
    ["hlink", theme.colors[1]],
    ["folHlink", theme.colors[3]],
  ];
  const font = (name: string, face: string) =>
    `<a:${name}><a:latin typeface="${esc(face)}"/><a:ea typeface="${esc(theme.eastAsia)}"/><a:cs typeface="${esc(face)}"/></a:${name}>`;
  const schemeFill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const lines = [9525, 25400, 38100]
    .map(
      (w) =>
        `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${schemeFill}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`,
    )
    .join("");
  const name = esc(theme.name);
  const palette = colors
    .map(([key, hex]) => `<a:${key}>${rgb(hex ?? theme.ink)}</a:${key}>`)
    .join("");
  const fonts = font("majorFont", theme.heading) + font("minorFont", theme.body);
  const formats = formatScheme(name, schemeFill, lines);
  return [
    `<a:theme xmlns:a="${A}" name="${name}"><a:themeElements>`,
    `<a:clrScheme name="${name}">${palette}</a:clrScheme>`,
    `<a:fontScheme name="${name}">${fonts}</a:fontScheme>${formats}</a:themeElements>`,
    "<a:objectDefaults/><a:extraClrSchemeLst/></a:theme>",
  ].join("");
}

function formatScheme(name: string, fill: string, lines: string) {
  const effects = "<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3);
  return [
    `<a:fmtScheme name="${name}"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst>`,
    `<a:lnStyleLst>${lines}</a:lnStyleLst><a:effectStyleLst>${effects}</a:effectStyleLst>`,
    `<a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme>`,
  ].join("");
}
