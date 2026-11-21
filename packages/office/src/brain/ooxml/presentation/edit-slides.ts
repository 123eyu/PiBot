import type { PptOperation } from "@pibot/protocol-base/office-ooxml";
import { DOC_REL, OfficePackage, relationshipPart, TYPES } from "../package.ts";
import { attribute } from "../xml.ts";
import { deck, slidePart } from "./edit-base.ts";
import { writePresentation } from "./index.ts";

type SlideOperation = Extract<PptOperation, { op: `ppt_slide_${string}` }>;
const SHARED = new Set(["slideLayout", "slideMaster", "theme", "notesMaster"]);

export function isSlideOperation(operation: PptOperation): operation is SlideOperation {
  return operation.op.startsWith("ppt_slide_");
}

export async function applySlideOperation(pkg: OfficePackage, operation: SlideOperation) {
  switch (operation.op) {
    case "ppt_slide_delete":
      deleteSlide(pkg, operation.slide);
      return;
    case "ppt_slide_move":
      moveSlide(pkg, operation.slide, operation.to);
      return;
    case "ppt_slide_duplicate":
      duplicateSlide(pkg, operation.slide);
      return;
    case "ppt_slide_add":
      await addSlide(pkg, operation.after, operation.content);
      return;
  }
}

function kindOf(type: string) {
  const index = type.lastIndexOf("/");
  return index < 0 ? "" : type.slice(index + 1);
}

/** addRelationship resolves targets relative to the source part, not the package root. */
function relative(source: string, part: string) {
  const from = source.split("/").slice(0, -1);
  const to = part.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
  return [...from.slice(shared).map(() => ".."), ...to.slice(shared)].join("/");
}

function deleteSlide(pkg: OfficePackage, slide: number) {
  const { part, xml, slides } = deck(pkg);
  const item = slides[slide - 1];
  if (!item) throw new Error("office_target_ambiguous");
  if (slides.length === 1) throw new Error("office_unsupported");
  const id = attribute(item, "id", DOC_REL);
  pkg.replaceXml(part, xml.source.slice(0, item.start) + xml.source.slice(item.end));
  if (id) removeRelationship(pkg, part, id);
}

function moveSlide(pkg: OfficePackage, slide: number, to: number) {
  const { part, xml, list, slides } = deck(pkg);
  const item = slides[slide - 1];
  if (!item) throw new Error("office_target_ambiguous");
  const target = Math.min(Math.max(to - 1, 0), slides.length - 1);
  const order = slides.filter((entry) => entry !== item);
  order.splice(target, 0, item);
  const slots = list.children.flatMap((entry, position) =>
    slides.includes(entry) ? [position] : [],
  );
  const children = [...list.children];
  slots.forEach((slot, position) => {
    const entry = order[position];
    if (entry) children[slot] = entry;
  });
  const inner = children.map((entry) => xml.source.slice(entry.start, entry.end)).join("");
  pkg.replaceXml(
    part,
    xml.source.slice(0, list.openEnd) + inner + xml.source.slice(list.closeStart),
  );
}

function removeRelationship(pkg: OfficePackage, source: string, id: string) {
  const part = relationshipPart(source);
  if (!pkg.has(part)) return;
  const xml = pkg.xml(part);
  const node = xml.root.children.find(
    (item) => item.name === "Relationship" && item.attrs.get("Id") === id,
  );
  if (node) pkg.replaceXml(part, xml.source.slice(0, node.start) + xml.source.slice(node.end));
}

function nextRelId(pkg: OfficePackage, source: string) {
  const ids = new Set(pkg.relationships(source).map((rel) => rel.id));
  for (let index = 1; index < 10_000; index++) if (!ids.has(`rId${index}`)) return `rId${index}`;
  throw new Error("office_unsupported");
}

function partContentType(pkg: OfficePackage, part: string) {
  const { root } = pkg.xml(TYPES);
  const path = `/${part.split("/").map(encodeURIComponent).join("/")}`;
  let fallback: string | undefined;
  const extension = part.includes(".") ? part.slice(part.lastIndexOf(".") + 1) : "";
  for (const node of root.children) {
    if (node.name === "Override" && node.attrs.get("PartName") === path)
      return node.attrs.get("ContentType") ?? fallback ?? missing();
    if (node.name === "Default" && node.attrs.get("Extension") === extension)
      fallback = node.attrs.get("ContentType");
  }
  if (fallback) return fallback;
  throw new Error("office_unsupported");
}
function missing(): never {
  throw new Error("office_unsupported");
}

/** Builds a free numbered sibling so repeated edits never overwrite existing parts. */
function uniqueName(pkg: OfficePackage, balance: string, extension: string) {
  for (let index = 1; index < 10_000; index++) {
    const name = `${balance}${index}${extension}`;
    if (!pkg.has(name)) return name;
  }
  throw new Error("office_unsupported");
}

function copyFrom(source: OfficePackage, target: OfficePackage, part: string): string {
  const name = uniqueName(
    target,
    part.slice(0, part.lastIndexOf(".")),
    part.slice(part.lastIndexOf(".")),
  );
  const bytes = source.readPart(part);
  if (!bytes) throw new Error("office_missing_part");
  target.addPart(name, bytes, partContentType(source, part));
  for (const rel of source.relationships(part)) {
    if (rel.external || !rel.target) throw new Error("office_unsupported");
    const copied = copyFrom(source, target, rel.target);
    target.addRelationship(name, rel.id, rel.type, relative(name, copied));
  }
  return name;
}

function duplicateSlide(pkg: OfficePackage, slide: number) {
  const source = slidePart(pkg, slide);
  const bytes = pkg.readPart(source.part);
  if (!bytes) throw new Error("office_missing_part");
  const part = uniqueName(pkg, source.part.slice(0, source.part.lastIndexOf(".")), ".xml");
  pkg.addPart(part, bytes, partContentType(pkg, source.part));
  for (const rel of pkg.relationships(source.part)) {
    if (rel.external || !rel.target) throw new Error("office_unsupported");
    const kind = kindOf(rel.type);
    if (SHARED.has(kind)) pkg.addRelationship(part, rel.id, rel.type, relative(part, rel.target));
    else if (kind === "notesSlide")
      pkg.addRelationship(part, rel.id, rel.type, relative(part, copyNotes(pkg, rel.target, part)));
    else
      pkg.addRelationship(part, rel.id, rel.type, relative(part, copyFrom(pkg, pkg, rel.target)));
  }
  insertSlideId(pkg, slide, part);
}

function copyNotes(pkg: OfficePackage, source: string, slide: string) {
  const bytes = pkg.readPart(source);
  if (!bytes) throw new Error("office_missing_part");
  const part = uniqueName(pkg, source.slice(0, source.lastIndexOf(".")), ".xml");
  pkg.addPart(part, bytes, partContentType(pkg, source));
  for (const rel of pkg.relationships(source)) {
    if (rel.external || !rel.target) throw new Error("office_unsupported");
    const kind = kindOf(rel.type);
    // The copied page became the new owner, so the back-reference is rewired rather than shared.
    if (kind === "slide") pkg.addRelationship(part, rel.id, rel.type, relative(part, slide));
    else if (SHARED.has(kind))
      pkg.addRelationship(part, rel.id, rel.type, relative(part, rel.target));
    else
      pkg.addRelationship(part, rel.id, rel.type, relative(part, copyFrom(pkg, pkg, rel.target)));
  }
  return part;
}

function insertSlideId(pkg: OfficePackage, after: number | undefined, part: string) {
  const { part: main, xml, list, slides } = deck(pkg);
  // sldId carries an unqualified id; only its r:id is namespaced.
  const existing = slides.flatMap((entry) => {
    const value = Number(entry.attrs.get("id"));
    return Number.isSafeInteger(value) ? [value] : [];
  });
  const id = Math.max(255, ...existing) + 1;
  if (id > 0xffff_ffff) throw new Error("office_unsupported");
  const relId = nextRelId(pkg, main);
  pkg.addRelationship(main, relId, `${DOC_REL}/slide`, relative(main, part));
  const tag = /^<([^\s/>]+)/u.exec(xml.source.slice(list.start, list.openEnd))?.[1] ?? "p:sldIdLst";
  const prefix = tag.includes(":") ? `${tag.split(":")[0]}:` : "";
  const index = after === undefined ? slides.length : Math.min(Math.max(after, 0), slides.length);
  const at = slides[index - 1]?.end ?? list.closeStart;
  const entry = `<${prefix}sldId id="${id}" r:id="${relId}"/>`;
  pkg.replaceXml(main, xml.source.slice(0, at) + entry + xml.source.slice(at));
}

function layoutFor(pkg: OfficePackage, after: number | undefined) {
  const { slides } = deck(pkg);
  const index =
    after === undefined ? slides.length - 1 : Math.min(Math.max(after - 1, 0), slides.length - 1);
  const candidates = index >= 0 ? [index + 1, 1] : [1];
  for (const candidate of candidates) {
    if (candidate > slides.length) continue;
    const source = slidePart(pkg, candidate);
    const rel = pkg
      .relationships(source.part)
      .find((item) => kindOf(item.type) === "slideLayout" && item.target);
    if (rel?.target) return rel.target;
  }
  throw new Error("office_unsupported");
}

async function addSlide(
  pkg: OfficePackage,
  after: number | undefined,
  content: Extract<PptOperation, { op: "ppt_slide_add" }>["content"],
) {
  if (content?.objects?.some((object) => object.type === "image"))
    throw new Error("office_unsupported");
  const { notes: _notes, ...slide } = content ?? { title: "Slide" };
  const generated = await writePresentation({ kind: "pptx", slides: [slide] }, {});
  const gen = await OfficePackage.open(generated);
  const genPart = "ppt/slides/slide1.xml";
  const bytes = gen.readPart(genPart);
  if (!bytes) throw new Error("office_invalid");
  const part = uniqueName(pkg, "ppt/slides/slide", ".xml");
  pkg.addPart(part, bytes, partContentType(gen, genPart));
  for (const rel of gen.relationships(genPart)) {
    if (kindOf(rel.type) === "slideLayout")
      pkg.addRelationship(part, rel.id, rel.type, relative(part, layoutFor(pkg, after)));
    else if (rel.external || !rel.target) throw new Error("office_unsupported");
    else
      pkg.addRelationship(part, rel.id, rel.type, relative(part, copyFrom(gen, pkg, rel.target)));
  }
  insertSlideId(pkg, after, part);
}
