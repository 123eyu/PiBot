import { DOC_REL, OfficePackage, resolveTarget, TYPES, TYPES_NS } from "../package.ts";
import { elements } from "../xml.ts";
import { presentationImageInfo } from "./image-info.ts";
import { A, P, type PresentationParts, pptType, themeType } from "./parts.ts";
import { layoutRoot, masterLayouts, placeholders, presentation, targets } from "./template-read.ts";
import { type Theme, themes } from "./themes.ts";

export type { Placeholder } from "./template-read.ts";
export { readPresentationLayouts } from "./template-read.ts";

function typeLookup(pkg: OfficePackage) {
  const root = pkg.xml(TYPES).root;
  if (root.uri !== TYPES_NS || root.name !== "Types") throw new Error("office_invalid");
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const item of root.children) {
    const type = item.attrs.get("ContentType");
    if (item.uri !== TYPES_NS || !type) throw new Error("office_invalid");
    const key = item.attrs.get(item.name === "Default" ? "Extension" : "PartName");
    if (!key) throw new Error("office_invalid");
    if (item.name === "Default" && !defaults.has(key.toLowerCase()))
      defaults.set(key.toLowerCase(), type);
    else if (item.name === "Override" && key.startsWith("/")) {
      const name = resolveTarget("", key);
      if (overrides.has(name)) throw new Error("office_invalid");
      overrides.set(name, type);
    } else throw new Error("office_invalid");
  }
  return (part: string) =>
    overrides.get(part) ?? defaults.get(part.split(".").at(-1)?.toLowerCase() ?? "");
}

type Role = "slideMaster" | "slideLayout" | "theme" | "image";
const next = {
  slideMaster: new Set<Role>(["slideLayout", "theme", "image"]),
  slideLayout: new Set<Role>(["slideMaster", "image"]),
  theme: new Set<Role>(["image"]),
  image: new Set<Role>(),
};
const expected = {
  slideMaster: pptType("slideMaster"),
  slideLayout: pptType("slideLayout"),
  theme: themeType,
};
function copySafeGraph(
  pkg: OfficePackage,
  parts: PresentationParts,
  master: string,
  layouts: string[],
) {
  const typeOf = typeLookup(pkg);
  const seen = new Map<string, Role>();
  let imageCount = 0,
    imageBytes = 0;
  const allowedLayouts = new Set(layouts);
  const walk = (part: string, role: Role) => {
    if (seen.get(part) === role) return;
    if (seen.has(part) || seen.size >= 256) throw new Error("office_unsupported");
    seen.set(part, role);
    const bytes = pkg.readPart(part);
    const type = typeOf(part);
    if (!bytes || !type) throw new Error("office_invalid");
    if (role === "image") {
      const info = presentationImageInfo(bytes);
      imageBytes += bytes.byteLength;
      if (info.contentType !== type || ++imageCount > 10 || imageBytes > 10 * 1024 * 1024)
        throw new Error("office_unsupported");
    } else {
      const root = pkg.xml(part).root;
      if (
        type !== expected[role] ||
        root.uri !== (role === "theme" ? A : P) ||
        root.name !==
          (role === "slideMaster" ? "sldMaster" : role === "slideLayout" ? "sldLayout" : "theme") ||
        Array.from(elements(root)).some(
          (node) =>
            [
              "oleObj",
              "control",
              "audioFile",
              "videoFile",
              "wavAudioFile",
              "snd",
              "contentPart",
              "hlinkClick",
              "hlinkHover",
            ].includes(node.name) || node.attrs.has("action"),
        )
      )
        throw new Error("office_unsupported");
    }
    parts.part(part, type, bytes);
    const rels = pkg.relationships(part);
    if (
      role === "slideLayout" &&
      rels.filter(({ type }) => type === `${DOC_REL}/slideMaster`).length !== 1
    )
      throw new Error("office_unsupported");
    for (const rel of rels) {
      const kind = rel.type.slice(DOC_REL.length + 1) as Role;
      if (
        !rel.type.startsWith(`${DOC_REL}/`) ||
        !rel.target ||
        !next[role].has(kind) ||
        (kind === "slideMaster" && rel.target !== master) ||
        (kind === "slideLayout" && !allowedLayouts.has(rel.target))
      )
        throw new Error("office_unsupported");
      walk(rel.target, kind);
      parts.relate(part, kind, rel.target, { id: rel.id });
    }
  };
  walk(master, "slideMaster");
  if (layouts.some((layout) => !seen.has(layout))) throw new Error("office_invalid");
}

function importedTheme(pkg: OfficePackage, master: string): Theme {
  const refs = pkg.relationships(master).filter((rel) => rel.type === `${DOC_REL}/theme`);
  if (refs.length !== 1 || !refs[0]?.target) throw new Error("office_unsupported");
  const root = pkg.xml(refs[0].target).root;
  const all = [...elements(root)];
  const scheme = all.find((node) => node.uri === A && node.name === "clrScheme");
  const color = (key: string, fallback: string) => {
    const value = scheme?.children.find((node) => node.uri === A && node.name === key)?.children[0];
    const hex =
      value?.name === "srgbClr"
        ? value.attrs.get("val")
        : value?.name === "sysClr"
          ? value.attrs.get("lastClr")
          : undefined;
    if (!hex || !/^[a-f0-9]{6}$/iu.test(hex)) return fallback;
    return hex.toUpperCase();
  };
  const fonts = (key: string, name: string, fallback: string) =>
    all
      .find((node) => node.uri === A && node.name === key)
      ?.children.find((node) => node.uri === A && node.name === name)
      ?.attrs.get("typeface") || fallback;
  const base = themes.classic;
  return {
    ...base,
    name: "User master",
    ink: color("dk1", base.ink),
    background: color("lt1", base.background),
    muted: color("dk2", base.muted),
    paper: color("lt2", base.paper),
    section: color("accent1", base.section),
    colors: [
      color("accent1", base.colors[0]),
      color("accent2", base.colors[1]),
      color("accent3", base.colors[2]),
      color("accent4", base.colors[3]),
      color("accent5", base.colors[4]),
      color("accent6", base.colors[5]),
    ],
    heading: fonts("majorFont", "latin", base.heading),
    body: fonts("minorFont", "latin", base.body),
    eastAsia: fonts("minorFont", "ea", base.eastAsia),
  };
}

export async function importPresentationTemplate(
  bytes: Uint8Array,
  parts: PresentationParts,
  ordinal: number,
  retainedTemplateParts: Set<string>,
) {
  const pkg = await OfficePackage.open(bytes);
  const { part, root, masterList } = presentation(pkg);
  const master = targets(pkg, part, masterList, "sldMasterId", "slideMaster")[ordinal - 1];
  const size = root.children.find((node) => node.uri === P && node.name === "sldSz");
  const width = Number(size?.attrs.get("cx"));
  const height = Number(size?.attrs.get("cy"));
  if (
    !master ||
    ![width, height].every(
      (value) => Number.isSafeInteger(value) && value >= 914400 && value <= 51_206_400,
    )
  )
    throw new Error("office_invalid");
  const layouts = masterLayouts(pkg, master);
  copySafeGraph(pkg, parts, master, layouts);
  retainedTemplateParts.add(master);
  for (const layout of layouts) retainedTemplateParts.add(layout);
  const masterSlots = placeholders(pkg.xml(master).root, width, height);
  const maxLayoutId = Math.max(
    ...pkg
      .xml(master)
      .root.children.filter((node) => node.name === "sldLayoutIdLst")
      .flatMap((node) => node.children.map((item) => Number(item.attrs.get("id") ?? 0))),
    0,
  );
  if (!Number.isInteger(maxLayoutId) || maxLayoutId < 2147483648 || maxLayoutId > 4294967295)
    throw new Error("office_invalid");
  return {
    master,
    maxLayoutId,
    width,
    height,
    theme: importedTheme(pkg, master),
    layouts: layouts.map((path) => ({
      path,
      placeholders: placeholders(layoutRoot(pkg, path), width, height).map((slot) => ({
        ...slot,
        box: slot.box ?? masterSlots.find((item) => item.type === slot.type)?.box,
      })),
    })),
  };
}
