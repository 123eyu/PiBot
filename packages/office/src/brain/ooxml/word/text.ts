import { one } from "../locate.ts";
import { type Element, elements, leafText } from "../xml.ts";
import type { WordDocument, WordLocator, WordOperation } from "./document.ts";

function replacementRange(d: WordDocument, locator: WordLocator, oldText: string) {
  const t = d.paragraph(locator),
    { xml, paragraph } = t;
  const nodes = t.nodes.filter((n) => n.name === "t");
  const combined = nodes.map((n) => leafText(xml, n) ?? "").join("");
  const at = combined.indexOf(oldText);
  if (!oldText || at < 0 || combined.indexOf(oldText, at + 1) >= 0)
    throw new Error("office_target_ambiguous");
  let offset = 0;
  const chosen = nodes.flatMap((n) => {
    const text = leafText(xml, n);
    if (text === undefined) throw new Error("office_unsupported");
    const start = offset;
    offset += text.length;
    return start < at + oldText.length && offset > at ? [{ n, text, start }] : [];
  });
  const first = chosen[0],
    last = chosen.at(-1);
  if (!first || !last) throw new Error("office_target_ambiguous");
  const runs = paragraph.children.filter(
    (n) => n.uri === d.uri && n.name === "r" && n.start <= last.n.start && n.end >= first.n.end,
  );
  const firstRun = runs[0],
    lastRun = runs.at(-1);
  if (!firstRun || !lastRun || first.n.start < firstRun.start || last.n.end > lastRun.end)
    throw new Error("office_unsupported");
  const runSet = new Set(runs);
  // Replacing fields, drawings, existing revisions or interleaved markers would discard unrelated structure.
  if (
    paragraph.children.some(
      (n) => n.start >= firstRun.start && n.end <= lastRun.end && !runSet.has(n),
    ) ||
    runs.some(
      (r) =>
        r.children.some((n) => n.uri !== d.uri || !["rPr", "t"].includes(n.name)) ||
        r.children.filter((n) => n.name === "t").length !== 1 ||
        Array.from(elements(r)).some((n) => n.name.endsWith("PrChange") && n.uri === d.uri),
    )
  )
    throw new Error("office_unsupported");
  return { ...t, chosen, at, runs, first, last, firstRun, lastRun };
}
export function replaceWordText(
  d: WordDocument,
  locator: WordLocator,
  oldText: string,
  newText: string,
  track: boolean,
) {
  const { xml, part, chosen, at, runs, first, last, firstRun, lastRun } = replacementRange(
    d,
    locator,
    oldText,
  );
  const props = (r: Element) => {
    const p = d.child(r, "rPr");
    return p ? d.raw(xml, p) : "";
  };
  let result = d.run(first.text.slice(0, at - first.start), props(firstRun));
  if (track) {
    let id = d.nextStoryId(newText ? 2 : 1);
    const formats = new Map(
      runs.flatMap((r) =>
        r.children
          .filter((n) => n.uri === d.uri && n.name === "t")
          .map((n) => [n.start, props(r)] as const),
      ),
    );
    const deleted = chosen
      .map(({ n, text, start }) =>
        d.run(
          text.slice(Math.max(0, at - start), Math.min(text.length, at + oldText.length - start)),
          formats.get(n.start) ?? "",
          true,
        ),
      )
      .join("");
    result += d.revision("del", id++, deleted);
    if (newText) result += d.revision("ins", id, d.run(newText, props(firstRun)));
  } else if (newText) result += d.run(newText, props(firstRun));
  result += d.run(last.text.slice(at + oldText.length - last.start), props(lastRun));
  d.patch(part, xml, [{ start: firstRun.start, end: lastRun.end, value: result }]);
}

export function bookmark(d: WordDocument, op: Extract<WordOperation, { op: "word_bookmark" }>) {
  if (op.action === "replace") {
    if (op.text === undefined) throw new Error("office_invalid");
    const locator = { kind: "word_bookmark" as const, name: op.name },
      t = d.paragraph(locator);
    const start = one(d.all(t.xml, "bookmarkStart").filter((n) => d.attr(n, "name") === op.name));
    const end = one(
      d.all(t.xml, "bookmarkEnd").filter((n) => d.attr(n, "id") === d.attr(start, "id")),
    );
    // Preserve both boundary markers; cross-paragraph ranges require structural operations from T8.
    if (!t.paragraph.children.includes(start) || !t.paragraph.children.includes(end))
      throw new Error("office_unsupported");
    const inner = t.paragraph.children.filter((n) => n.start >= start.end && n.end <= end.start);
    if (
      inner.some(
        (n) =>
          n.uri !== d.uri ||
          n.name !== "r" ||
          n.children.some((c) => c.uri !== d.uri || !["rPr", "t"].includes(c.name)),
      )
    )
      throw new Error("office_unsupported");
    const text = inner.map((n) => d.plain(t.xml, n)).join("");
    if (op.track && text) replaceWordText(d, locator, text, op.text, true);
    else if (op.track) {
      const id = d.nextStoryId();
      d.patch(t.part, t.xml, [
        { start: start.end, end: end.start, value: d.revision("ins", id, d.run(op.text)) },
      ]);
    } else {
      const p = inner[0] && d.child(inner[0], "rPr");
      d.patch(t.part, t.xml, [
        { start: start.end, end: end.start, value: d.run(op.text, p ? d.raw(t.xml, p) : "") },
      ]);
    }
    return;
  }
  if (!op.locator) throw new Error("office_invalid");
  const t = d.paragraph(op.locator);
  if (d.all(t.xml, "bookmarkStart").some((n) => d.attr(n, "name") === op.name))
    throw new Error("office_target_ambiguous");
  const id = d.nextStoryId(),
    ppr = d.child(t.paragraph, "pPr");
  if (t.paragraph.closeStart === t.paragraph.end) {
    d.insert(
      t.part,
      t.xml,
      t.paragraph,
      d.tag("bookmarkStart", { id, name: op.name }) + d.tag("bookmarkEnd", { id }),
    );
    return;
  }
  d.patch(t.part, t.xml, [
    {
      start: t.paragraph.closeStart,
      end: t.paragraph.closeStart,
      value: d.tag("bookmarkEnd", { id }),
    },
    {
      start: ppr?.end ?? t.paragraph.openEnd,
      end: ppr?.end ?? t.paragraph.openEnd,
      value: d.tag("bookmarkStart", { id, name: op.name }),
    },
  ]);
}
