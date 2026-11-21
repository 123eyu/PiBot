import type { OfficePackage } from "../ooxml/package.ts";
import { attribute, type Element, elements, leafText, type XmlPart } from "../ooxml/xml.ts";
import { type Change, clip, insertAt } from "./blocks.ts";

const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const WORKBOOK = "xl/workbook.xml";
const SHARED = "xl/sharedStrings.xml";
const CHART = /^xl\/charts\/[^/]+\.xml$/u;
const PIVOT = /^xl\/pivotTables\/[^/]+\.xml$/u;

function textOf(xml: XmlPart, node: Element) {
  const parts: string[] = [];
  for (const child of elements(node)) {
    if (child.uri !== S || child.name !== "t") continue;
    const value = leafText(xml, child);
    if (value) parts.push(value);
  }
  return parts.join("");
}

function sharedStrings(pkg: OfficePackage) {
  if (!pkg.has(SHARED)) return [];
  const xml = pkg.xml(SHARED);
  return xml.root.children
    .filter((node) => node.uri === S && node.name === "si")
    .map((node) => textOf(xml, node));
}

function worksheets(pkg: OfficePackage) {
  const targets = new Map(
    pkg
      .relationships(WORKBOOK)
      .filter(({ target }) => target !== undefined)
      .map(({ id, target }) => [id, target as string]),
  );
  const xml = pkg.xml(WORKBOOK);
  const list = xml.root.children.find((child) => child.uri === S && child.name === "sheets");
  const sheets: { name: string; part: string }[] = [];
  for (const node of list?.children ?? []) {
    if (node.uri !== S || node.name !== "sheet") continue;
    const id = node.attrs.get("r:id") ?? [...node.attrs].find(([key]) => key.endsWith(":id"))?.[1];
    const part = id ? targets.get(id) : undefined;
    if (part) sheets.push({ name: node.attrs.get("name") ?? "", part });
  }
  return sheets;
}

interface Row {
  number: number;
  cells: Map<string, string>;
  signature: string;
  raw: string;
  start: number;
  end: number;
}

function cellKey(xml: XmlPart, cell: Element, shared: string[]) {
  const type = cell.attrs.get("t") ?? "";
  const style = cell.attrs.get("s") ?? "";
  let value = "";
  let formula = "";
  for (const child of cell.children) {
    if (child.uri !== S) continue;
    if (child.name === "v") value = leafText(xml, child) ?? "";
    else if (child.name === "f") formula = leafText(xml, child) ?? "";
    else if (child.name === "is") value = textOf(xml, child);
  }
  // Shared-string indices shift when the table is rebuilt, so compare the text they resolve to.
  if (type === "s") value = shared[Number(value)] ?? value;
  return {
    address: cell.attrs.get("r") ?? "",
    signature: `${type}|${style}|${value}|${formula}`,
  };
}

function sheetRows(pkg: OfficePackage, part: string, shared: string[]) {
  const xml = pkg.xml(part);
  const data = [...elements(xml.root)].find((node) => node.uri === S && node.name === "sheetData");
  const rows = new Map<number, Row>();
  if (!data) return { rows, end: 0 };
  let position = 0;
  for (const node of data.children) {
    if (node.uri !== S || node.name !== "row") continue;
    position++;
    const number = Number(node.attrs.get("r") ?? position) || position;
    const cells = new Map<string, string>();
    const signature: string[] = [];
    for (const cell of node.children) {
      if (cell.uri !== S || cell.name !== "c") continue;
      const key = cellKey(xml, cell, shared);
      cells.set(key.address, key.signature);
      signature.push(`${key.address}=${key.signature}`);
    }
    rows.set(number, {
      number,
      cells,
      signature: signature.join("\n"),
      raw: xml.source.slice(node.start, node.end),
      start: node.start,
      end: node.end,
    });
  }
  return { rows, end: data.closeStart };
}

function column(address: string) {
  return /^[A-Z]+/u.exec(address)?.[0] ?? "";
}

function area(cells: Iterable<string>) {
  const columns: string[] = [];
  for (const address of cells) {
    const name = column(address);
    if (name && !columns.includes(name)) columns.push(name);
  }
  if (!columns.length) return null;
  columns.sort((left, right) => left.length - right.length || left.localeCompare(right));
  const first = columns[0] as string;
  const last = columns[columns.length - 1] as string;
  return first === last ? first : `${first}:${last}`;
}

/** Rows of one sheet, one list line per run: Excel users think in row bands, not in cells. */
function sheetChanges(
  before: OfficePackage,
  after: OfficePackage,
  index: number,
  name: string,
  leftPart: string | undefined,
  rightPart: string | undefined,
  shared: { before: string[]; after: string[] },
): Change[] {
  const left = leftPart ? sheetRows(before, leftPart, shared.before) : { rows: new Map(), end: 0 };
  const right = rightPart ? sheetRows(after, rightPart, shared.after) : { rows: new Map(), end: 0 };
  const numbers = [...new Set([...left.rows.keys(), ...right.rows.keys()])].sort((a, b) => a - b);
  type Entry = { number: number; kind: "modify" | "add" | "remove"; cells: string[] };
  const entries: Entry[] = [];
  for (const number of numbers) {
    const old = left.rows.get(number) as Row | undefined;
    const next = right.rows.get(number) as Row | undefined;
    if (old && next) {
      if (old.signature === next.signature) continue;
      const changed = [...next.cells.keys()].filter(
        (key) => old.cells.get(key) !== next.cells.get(key),
      );
      entries.push({ number, kind: "modify", cells: changed });
    } else entries.push({ number, kind: old ? "remove" : "add", cells: [] });
  }
  const changes: Change[] = [];
  let run: Entry[] = [];
  const flush = () => {
    if (!run.length) return;
    const kind = (run[0] as Entry).kind;
    const first = (run[0] as Entry).number;
    const last = (run[run.length - 1] as Entry).number;
    const firstRow = run[0] as Entry;
    const span = area(firstRow.cells);
    const changed = run
      .flatMap((entry) => entry.cells)
      .map((key) => key)
      .slice(0, 3);
    const before_ = run
      .map((entry) => left.rows.get(entry.number))
      .filter((row): row is Row => !!row);
    const after_ = run
      .map((entry) => right.rows.get(entry.number))
      .filter((row): row is Row => !!row);
    const label = (rows: Row[]) =>
      clip(
        rows
          .slice(0, 3)
          .map((row) => [...row.cells.keys()].slice(0, 3).join(" "))
          .join(" · "),
      );
    const id = `xl:${index}:${first}-${last}`;
    changes.push({
      item: {
        id,
        kind: "cell_range",
        page: index + 1,
        name: name || null,
        area: span ? `${span}${first === last ? first : `${first}:${last}`}` : null,
        before: kind === "add" ? null : label(before_) || null,
        after: kind === "remove" ? null : label(after_) || null,
        retractable: !!rightPart,
      },
      apply: rightPart
        ? (pkg) => {
            const source = pkg.xml(rightPart).source;
            const edits: { start: number; end: number; text: string }[] = [];
            let anchor = right.end;
            for (const entry of [...run].reverse()) {
              const old = left.rows.get(entry.number);
              const next = right.rows.get(entry.number);
              if (entry.kind === "modify" && old && next)
                edits.push({ start: next.start, end: next.end, text: old.raw });
              else if (entry.kind === "add" && next)
                edits.push({ start: next.start, end: next.end, text: "" });
              else if (entry.kind === "remove" && old)
                edits.push({ start: anchor, end: anchor, text: old.raw });
              anchor = next ? next.start : anchor;
            }
            let result = source;
            for (const edit of edits.sort((a, b) => b.start - a.start))
              result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
            pkg.replaceXml(rightPart, result);
          }
        : undefined,
    });
    void changed;
    run = [];
  };
  for (const entry of entries) {
    const previous = run[run.length - 1];
    if (previous && (previous.kind !== entry.kind || previous.number !== entry.number - 1)) flush();
    run.push(entry);
  }
  flush();
  return changes;
}

function partChanges(
  before: OfficePackage,
  after: OfficePackage,
  pattern: RegExp,
  kind: "chart" | "pivot",
): Change[] {
  const changes: Change[] = [];
  const names = new Set([...before.names(), ...after.names()]);
  for (const part of [...names].sort()) {
    if (!pattern.test(part)) continue;
    const old = before.readPart(part);
    const next = after.readPart(part);
    if (old && next && Buffer.compare(old, next) === 0) continue;
    changes.push({
      item: {
        id: `${kind}:${part}`,
        kind,
        page: null,
        // Part names are stable inside the package and are the only identity a chart has.
        name: part.split("/").pop() ?? null,
        area: null,
        before: old ? kind : null,
        after: next ? kind : null,
        retractable: !!old && !!next,
      },
      apply:
        old && next
          ? (pkg) => {
              pkg.replacePart(part, old);
            }
          : undefined,
    });
  }
  return changes;
}

export function excelChanges(before: OfficePackage, after: OfficePackage): Change[] {
  const shared = { before: sharedStrings(before), after: sharedStrings(after) };
  const leftSheets = worksheets(before);
  const rightSheets = worksheets(after);
  const leftByName = new Map(leftSheets.map((sheet) => [sheet.name, sheet.part]));
  const rightByName = new Map(rightSheets.map((sheet) => [sheet.name, sheet.part]));
  const changes: Change[] = [];
  rightSheets.forEach((sheet, index) => {
    changes.push(
      ...sheetChanges(
        before,
        after,
        index,
        sheet.name,
        leftByName.get(sheet.name),
        sheet.part,
        shared,
      ),
    );
  });
  for (const [index, sheet] of leftSheets.entries())
    if (!rightByName.has(sheet.name))
      changes.push({
        item: {
          id: `xl:${index}:sheet-`,
          kind: "sheet",
          page: index + 1,
          name: sheet.name || null,
          area: null,
          before: sheet.name || null,
          after: null,
          // Dropping a whole worksheet also rewrites the workbook and its relationships.
          retractable: false,
        },
      });
  if (rightSheets.length !== leftSheets.length)
    for (const sheet of rightSheets)
      if (!leftByName.has(sheet.name))
        changes.push({
          item: {
            id: `xl:${sheet.name}:sheet+`,
            kind: "sheet",
            page: rightSheets.indexOf(sheet) + 1,
            name: sheet.name || null,
            area: null,
            before: null,
            after: sheet.name || null,
            retractable: false,
          },
        });
  changes.push(...partChanges(before, after, CHART, "chart"));
  changes.push(...partChanges(before, after, PIVOT, "pivot"));
  return changes;
}
