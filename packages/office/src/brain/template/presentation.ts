import { posix } from "node:path";
import type { OfficePackage } from "../ooxml/package.ts";
import { DOC_REL, relationshipPart, TYPES } from "../ooxml/package.ts";
import { type Element, encoder, parsePart } from "../ooxml/xml.ts";
import type { TemplateBudget } from "./budget.ts";
import {
  addScope,
  blockTag,
  eachPath,
  parseTemplate,
  renderTemplate,
  resolveItems,
  type TemplateField,
  type TemplateScope,
  type TemplateValue,
} from "./engine.ts";
import {
  applyEdits,
  attribute,
  directChild,
  find,
  mergedText,
  prefixOf,
  runXml,
  simpleRuns,
} from "./xml-text.ts";

export interface PresentationTemplateStats {
  fields: TemplateField[];
  warnings: string[];
  replacements: number;
  loops: number;
  /** Extra slides created by a slide-level `{{#each}}`. */
  slides: number;
}

const RUNS = { run: ["rPr", "t"], paragraph: ["pPr", "endParaRPr"] } as const;
type Edit = { start: number; end: number; value: string };
type Unit = { paragraph: Element; text: string };

function paragraphText(source: ReturnType<typeof parsePart>, paragraph: Element) {
  return mergedText(source, paragraph, "r", "t", { breakName: "br" });
}

/** Rebuilds an `a:p` around one value, keeping its paragraph and first-run formatting. */
function rebuilt(source: string, paragraph: Element, text: string, budget: TemplateBudget) {
  const layout = simpleRuns(paragraph, "r", RUNS);
  if (!layout) return undefined;
  const props = layout.runs[0]?.children.find((node) => node.name === "rPr");
  const ppr = directChild(paragraph, "pPr");
  const end = directChild(paragraph, "endParaRPr");
  const open = source.slice(paragraph.start, paragraph.openEnd);
  const close = source.slice(paragraph.closeStart, paragraph.end);
  const body = runXml(
    prefixOf(source, paragraph),
    "t",
    text,
    props ? source.slice(props.start, props.end) : "",
    budget,
    { breakName: "br" },
  );
  return `${open}${ppr ? source.slice(ppr.start, ppr.end) : ""}${body}${end ? source.slice(end.start, end.end) : ""}${close}`;
}

function units(source: ReturnType<typeof parsePart>): Unit[] {
  return find(source.root, "p").map((paragraph) => ({
    paragraph,
    text: paragraphText(source, paragraph),
  }));
}

export function slideParts(pkg: OfficePackage) {
  const main = pkg.mainPart();
  const rels = pkg.relationships(main);
  const list = find(pkg.xml(main).root, "sldIdLst")[0];
  if (!list) throw new Error("office_invalid");
  return list.children.map((node, index) => {
    const id = attribute(node, "id", DOC_REL);
    const target = rels.find((rel) => rel.id === id)?.target;
    if (!target) throw new Error("office_invalid_relationship");
    return { node, part: target, ordinal: index + 1 };
  });
}

export function pptFields(pkg: OfficePackage, budget: TemplateBudget): PresentationTemplateStats {
  const stats: PresentationTemplateStats = {
    fields: [],
    warnings: [],
    replacements: 0,
    loops: 0,
    slides: 0,
  };
  for (const { part, ordinal } of slideParts(pkg)) {
    const parsed = pkg.xml(part);
    for (const unit of units(parsed))
      if (unit.text.includes("{{")) {
        const fields = parseTemplate(unit.text, budget).fields;
        addScope(fields, `ppt:slide${ordinal}`);
        for (const field of fields) {
          const known = stats.fields.find((item) => item.path === field.path);
          if (!known) stats.fields.push(field);
          else {
            known.count += field.count;
            for (const kind of field.kinds) if (!known.kinds.includes(kind)) known.kinds.push(kind);
            for (const scope of field.scopes)
              if (!known.scopes.includes(scope)) known.scopes.push(scope);
          }
        }
      }
  }
  return stats;
}

function renderEdits(
  source: string,
  list: Unit[],
  data: TemplateValue,
  scopes: TemplateScope[],
  stats: PresentationTemplateStats,
  budget: TemplateBudget,
) {
  const edits: Edit[] = [];
  for (const unit of list) {
    if (blockTag(unit.text)) {
      // Block markers are consumed by the structural passes; a stray one never prints.
      edits.push({ start: unit.paragraph.start, end: unit.paragraph.end, value: "" });
      continue;
    }
    if (!unit.text.includes("{{")) continue;
    const value = rebuilt(
      source,
      unit.paragraph,
      renderTemplate(parseTemplate(unit.text, budget).nodes, data, budget, scopes),
      budget,
    );
    if (value === undefined) {
      stats.warnings.push("ppt_shape_unsupported");
      continue;
    }
    edits.push({ start: unit.paragraph.start, end: unit.paragraph.end, value });
    stats.replacements++;
  }
  return edits;
}

/** Table rows holding both loop markers are copied once per item. */
function repeatRows(
  source: string,
  data: TemplateValue,
  scopes: TemplateScope[],
  stats: PresentationTemplateStats,
  budget: TemplateBudget,
) {
  const parsed = parsePart(encoder.encode(source));
  const list = units(parsed);
  const edits: Edit[] = [];
  for (const row of find(parsed.root, "tr")) {
    const cells = list.filter(
      (unit) => unit.paragraph.start >= row.start && unit.paragraph.end <= row.end,
    );
    const start = cells.findIndex((unit) => {
      const tag = blockTag(unit.text);
      return tag?.kind === "start" && tag.tag.startsWith("#each");
    });
    if (start < 0) continue;
    const close = cells.findIndex((unit, at) => at > start && blockTag(unit.text)?.kind === "end");
    const path = eachPath(blockTag((cells[start] as Unit).text)?.tag ?? "");
    if (!path || close < 0) {
      stats.warnings.push("ppt_row_loop_unclosed");
      continue;
    }
    const items = resolveItems(path, data);
    if (!items.length) stats.warnings.push("ppt_loop_empty");
    budget.repeat(items.length, [row]);
    const rowSource = parsed.source.slice(row.start, row.end);
    const copies = items.map((item, at) => {
      const inner: Edit[] = [];
      cells.forEach((unit, position) => {
        const span = {
          start: unit.paragraph.start - row.start,
          end: unit.paragraph.end - row.start,
        };
        if (position >= start && position <= close) {
          inner.push({ ...span, value: "" });
          return;
        }
        if (!unit.text.includes("{{")) return;
        const value = rebuilt(
          parsed.source,
          unit.paragraph,
          renderTemplate(parseTemplate(unit.text, budget).nodes, data, budget, [
            ...scopes,
            { value: item, index: at, count: items.length },
          ]),
          budget,
        );
        if (value === undefined) stats.warnings.push("ppt_cell_unsupported");
        else inner.push({ ...span, value });
      });
      return applyEdits(rowSource, inner);
    });
    edits.push({ start: row.start, end: row.end, value: copies.join("") });
    stats.loops++;
  }
  return edits.length ? applyEdits(source, edits) : source;
}

function fillSlide(
  pkg: OfficePackage,
  part: string,
  data: TemplateValue,
  scopes: TemplateScope[],
  stats: PresentationTemplateStats,
  budget: TemplateBudget,
) {
  const parsed = pkg.xml(part);
  const rowed = repeatRows(parsed.source, data, scopes, stats, budget);
  const reparsed = parsePart(encoder.encode(rowed));
  const edits = renderEdits(reparsed.source, units(reparsed), data, scopes, stats, budget);
  const filled = edits.length ? applyEdits(reparsed.source, edits) : reparsed.source;
  if (filled !== parsed.source) pkg.replacePart(part, encoder.encode(filled));
}

function contentType(pkg: OfficePackage, part: string) {
  for (const node of pkg.xml(TYPES).root.children)
    if (node.name === "Override" && node.attrs.get("PartName") === `/${part}`)
      return node.attrs.get("ContentType");
  return undefined;
}

/** Adds one slide part with a copy of its relationships and a relationship from the presentation. */
function addSlidePart(pkg: OfficePackage, main: string, original: string, bytes: Uint8Array) {
  const directory = posix.dirname(original);
  let index = 1;
  let part = "";
  do part = `${directory}/pibotSlide${index++}.xml`;
  while (pkg.has(part) || pkg.has(relationshipPart(part)));
  const type = contentType(pkg, original);
  if (!type) throw new Error("office_invalid_part");
  pkg.addPart(part, bytes, type);
  const rels = pkg.readPart(relationshipPart(original));
  if (rels) pkg.addRelationshipPart(relationshipPart(part), rels);
  const used = new Set(pkg.relationships(main).map((rel) => rel.id));
  let serial = used.size + 1;
  while (used.has(`rId${serial}`)) serial++;
  pkg.addRelationship(
    main,
    `rId${serial}`,
    `${DOC_REL}/slide`,
    posix.relative(posix.dirname(main), part),
  );
  return `rId${serial}`;
}

export function pptFill(
  pkg: OfficePackage,
  data: TemplateValue,
  budget: TemplateBudget,
): PresentationTemplateStats {
  const stats = pptFields(pkg, budget);
  const main = pkg.mainPart();
  const anchors = new Map<Element, string[]>();
  let nextId = 256;
  for (const node of find(pkg.xml(main).root, "sldId"))
    nextId = Math.max(nextId, Number(node.attrs.get("id") ?? 0) + 1);

  for (const entry of slideParts(pkg)) {
    const parsed = pkg.xml(entry.part);
    const list = units(parsed);
    const start = list.findIndex((unit) => {
      const tag = blockTag(unit.text);
      return tag?.kind === "start" && tag.tag.startsWith("#each");
    });
    const close =
      start < 0
        ? -1
        : list.findIndex((unit, at) => at > start && blockTag(unit.text)?.kind === "end");
    const path = start < 0 ? undefined : eachPath(blockTag((list[start] as Unit).text)?.tag ?? "");
    if (start < 0 || close < 0 || !path) {
      if (list.some((unit) => blockTag(unit.text)?.tag.includes("if")))
        stats.warnings.push("ppt_block_if_unsupported");
      if (start >= 0) stats.warnings.push("ppt_slide_loop_unclosed");
      fillSlide(pkg, entry.part, data, [{ value: data }], stats, budget);
      continue;
    }
    const items = resolveItems(path, data);
    if (!items.length) stats.warnings.push("ppt_loop_empty");
    budget.repeat(items.length || 1, [parsed.root]);
    const rels = pkg.readPart(relationshipPart(entry.part));
    if (rels) budget.expand(0, Math.max(0, items.length - 1) * rels.byteLength);
    const markerless = applyEdits(
      parsed.source,
      list
        .filter((unit) => blockTag(unit.text))
        .map((unit) => ({ start: unit.paragraph.start, end: unit.paragraph.end, value: "" })),
    );
    const copies = items.length ? items : [undefined];
    copies.forEach((item, at) => {
      const scopes: TemplateScope[] =
        item === undefined
          ? [{ value: data }]
          : [{ value: data }, { value: item, index: at, count: items.length }];
      const copy = parsePart(encoder.encode(markerless));
      const rendered = applyEdits(
        copy.source,
        renderEdits(copy.source, units(copy), data, scopes, stats, budget),
      );
      const bytes = encoder.encode(repeatRows(rendered, data, scopes, stats, budget));
      if (at === 0) pkg.replacePart(entry.part, bytes);
      else {
        const rid = addSlidePart(pkg, main, entry.part, bytes);
        anchors.set(entry.node, [
          ...(anchors.get(entry.node) ?? []),
          `<${prefixOf(pkg.xml(main).source, entry.node)}sldId id="${nextId++}" r:id="${rid}"/>`,
        ]);
        stats.slides++;
      }
    });
    stats.loops++;
  }

  if (anchors.size) {
    const presentation = pkg.xml(main);
    const prefix = prefixOf(presentation.source, presentation.root);
    const edits: Edit[] = [];
    for (const [node, entries] of anchors)
      edits.push({
        start: node.end,
        end: node.end,
        value: entries.map((entry) => entry.replace(/^<[^:>]*:/u, `<${prefix}`)).join(""),
      });
    pkg.replaceXml(main, applyEdits(presentation.source, edits));
  }
  return stats;
}
