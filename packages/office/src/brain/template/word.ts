import type { OfficePackage } from "../ooxml/package.ts";
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
  directChild,
  find,
  mergedText,
  prefixOf,
  runXml,
  simpleRuns,
} from "./xml-text.ts";

export interface WordTemplateStats {
  fields: TemplateField[];
  warnings: string[];
  replacements: number;
  loops: number;
}

// The first run's properties carry the placeholder's formatting; anything else in the paragraph
// (fields, drawings, revision markers) is left alone rather than silently deleted.
const RUNS = { run: ["rPr", "t"], paragraph: ["pPr"] } as const;
type Unit = { paragraph: Element; text: string };

/**
 * Word stories a template may touch: the body plus every header/footer part, each filled
 * independently because they hold separate text but share the same data.
 */
export function wordParts(pkg: OfficePackage) {
  const main = pkg.mainPart();
  return [
    { part: main, story: "body" },
    ...[...pkg.names()]
      .filter((name) => /^word\/(header|footer)[^/]*\.xml$/u.test(name))
      .map((name) => ({ part: name, story: name.replace(/^word\//u, "").replace(/\.xml$/u, "") })),
  ];
}

function textOf(source: ReturnType<typeof parsePart>, paragraph: Element) {
  return mergedText(source, paragraph, "r", "t", { tab: "tab", breakName: "br" });
}

function units(source: ReturnType<typeof parsePart>, root: Element): Unit[] {
  return find(root, "p").map((paragraph) => ({ paragraph, text: textOf(source, paragraph) }));
}

/** The paragraph rebuilt around one text value; undefined when it holds structure we must not drop. */
function rebuilt(source: string, paragraph: Element, text: string, budget: TemplateBudget) {
  const layout = simpleRuns(paragraph, "r", RUNS);
  if (!layout) return undefined;
  const props = layout.runs[0]?.children.find((node) => node.name === "rPr");
  const ppr = directChild(paragraph, "pPr");
  const open = source.slice(paragraph.start, paragraph.openEnd);
  const close = source.slice(paragraph.closeStart, paragraph.end);
  const body = runXml(
    prefixOf(source, paragraph),
    "t",
    text,
    props ? source.slice(props.start, props.end) : "",
    budget,
    {
      breakName: "br",
    },
  );
  return `${open}${ppr ? source.slice(ppr.start, ppr.end) : ""}${body}${close}`;
}

function evaluateIf(expression: string, data: TemplateValue, budget: TemplateBudget) {
  const probe = parseTemplate(`{{#if ${expression}}}1{{/if}}`, budget);
  return renderTemplate(probe.nodes, data, budget) === "1";
}

/** Paragraphs between a standalone `{{#each}}` and `{{/each}}`, rendered once per item. */
function renderSequence(
  units: readonly Unit[],
  source: string,
  data: TemplateValue,
  scopes: TemplateScope[],
  budget: TemplateBudget,
) {
  return units
    .map((unit) =>
      unit.text.includes("{{")
        ? (rebuilt(
            source,
            unit.paragraph,
            renderTemplate(parseTemplate(unit.text, budget).nodes, data, budget, scopes),
            budget,
          ) ?? "")
        : source.slice(unit.paragraph.start, unit.paragraph.end),
    )
    .join("");
}

function blockEdits(
  source: string,
  list: readonly Unit[],
  data: TemplateValue,
  scopes: TemplateScope[],
  stats: WordTemplateStats,
  budget: TemplateBudget,
) {
  const edits: { start: number; end: number; value: string }[] = [];
  let index = 0;
  while (index < list.length) {
    const unit = list[index] as Unit;
    const tag = blockTag(unit.text);
    if (tag?.kind === "start") {
      const kind = tag.tag.startsWith("#each") ? "each" : "if";
      let depth = 0;
      let close = -1;
      let otherwise = -1;
      for (let i = index; i < list.length; i++) {
        const inner = blockTag((list[i] as Unit).text);
        if (!inner) continue;
        if (kind === "if" && depth === 1 && inner.kind === "else" && otherwise < 0) {
          otherwise = i;
          continue;
        }
        const innerKind = inner.tag.replace(/^\//u, "").split(/\s/u)[0]?.replace(/^#/u, "");
        if (innerKind !== kind) continue;
        if (inner.kind === "start") budget.depth(++depth);
        else if (inner.kind === "end" && --depth === 0) {
          close = i;
          break;
        }
      }
      if (close < 0) {
        stats.warnings.push("word_loop_unclosed");
        index++;
        continue;
      }
      const inner = list.slice(index + 1, close);
      const first = unit.paragraph;
      const last = (list[close] as Unit).paragraph;
      let value = "";
      if (kind === "each") {
        const path = eachPath(tag.tag);
        const items = path ? resolveItems(path, data) : [];
        if (!path || !items.length) stats.warnings.push("word_loop_empty");
        budget.repeat(
          items.length,
          inner.map(({ paragraph }) => paragraph),
        );
        value = items
          .map((item, at) =>
            renderSequence(
              inner,
              source,
              data,
              [...scopes, { value: item, index: at, count: items.length }],
              budget,
            ),
          )
          .join("");
        stats.loops++;
      } else {
        const keep = evaluateIf(tag.tag.slice(3).trim(), data, budget);
        const branch = keep
          ? list.slice(index + 1, otherwise < 0 ? close : otherwise)
          : otherwise < 0
            ? []
            : list.slice(otherwise + 1, close);
        value = renderSequence(branch, source, data, scopes, budget);
      }
      edits.push({ start: first.start, end: last.end, value });
      index = close + 1;
      continue;
    }
    if (tag?.kind === "end") {
      edits.push({ start: unit.paragraph.start, end: unit.paragraph.end, value: "" });
      index++;
      continue;
    }
    if (unit.text.includes("{{")) {
      const rendered = renderTemplate(parseTemplate(unit.text, budget).nodes, data, budget, scopes);
      const value = rebuilt(source, unit.paragraph, rendered, budget);
      if (value === undefined) stats.warnings.push("word_paragraph_unsupported");
      else {
        edits.push({ start: unit.paragraph.start, end: unit.paragraph.end, value });
        stats.replacements++;
      }
    }
    index++;
  }
  return edits;
}

/** Copies a table row once per item when both loop markers sit inside it. */
export function wordFields(pkg: OfficePackage, budget: TemplateBudget): WordTemplateStats {
  const stats: WordTemplateStats = { fields: [], warnings: [], replacements: 0, loops: 0 };
  for (const { part, story } of wordParts(pkg)) {
    const parsed = pkg.xml(part);
    for (const unit of units(parsed, parsed.root))
      if (unit.text.includes("{{")) {
        const fields = parseTemplate(unit.text, budget).fields;
        addScope(fields, `word:${story}`);
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

export function wordFill(
  pkg: OfficePackage,
  data: TemplateValue,
  budget: TemplateBudget,
): WordTemplateStats {
  const stats = wordFields(pkg, budget);
  for (const { part } of wordParts(pkg)) {
    const parsed = pkg.xml(part);
    const list = units(parsed, parsed.root);
    const rows = find(parsed.root, "tr");
    let next = parsed.source;
    const rowOps: { start: number; end: number; value: string }[] = [];
    for (const row of rows) {
      const rowUnits = list.filter(
        (unit) => unit.paragraph.start >= row.start && unit.paragraph.end <= row.end,
      );
      const start = rowUnits.findIndex((unit) => {
        const tag = blockTag(unit.text);
        return tag?.kind === "start" && tag.tag.startsWith("#each");
      });
      if (start < 0) continue;
      const path = eachPath(blockTag((rowUnits[start] as Unit).text)?.tag ?? "");
      const close = rowUnits.findIndex(
        (unit, at) => at > start && blockTag(unit.text)?.kind === "end",
      );
      if (!path || close < 0) continue;
      const items = resolveItems(path, data);
      budget.repeat(items.length, [row]);
      const rowSource = parsed.source.slice(row.start, row.end);
      const copies = items.map((item, at) => {
        const scopes: TemplateScope[] = [
          { value: data },
          { value: item, index: at, count: items.length },
        ];
        const inner: { start: number; end: number; value: string }[] = [];
        rowUnits.forEach((unit, position) => {
          const relative = {
            start: unit.paragraph.start - row.start,
            end: unit.paragraph.end - row.start,
          };
          if (position >= start && position <= close) {
            inner.push({ ...relative, value: "" });
            return;
          }
          if (!unit.text.includes("{{")) return;
          const rebuiltXml = rebuilt(
            parsed.source,
            unit.paragraph,
            renderTemplate(parseTemplate(unit.text, budget).nodes, data, budget, scopes),
            budget,
          );
          if (rebuiltXml === undefined) stats.warnings.push("word_row_cell_unsupported");
          else inner.push({ ...relative, value: rebuiltXml });
        });
        return applyEdits(rowSource, inner);
      });
      rowOps.push({ start: row.start, end: row.end, value: copies.join("") });
      stats.loops++;
    }
    if (rowOps.length) {
      next = applyEdits(parsed.source, rowOps);
      stats.replacements += rowOps.length;
    }
    const reparsed = parsePart(encoder.encode(next));
    const edits = blockEdits(
      reparsed.source,
      units(reparsed, reparsed.root),
      data,
      [{ value: data }],
      stats,
      budget,
    );
    const filled = edits.length ? applyEdits(reparsed.source, edits) : reparsed.source;
    if (filled !== parsed.source) pkg.replaceXml(part, filled);
  }
  return stats;
}
