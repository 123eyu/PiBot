import { posix } from "node:path";
import type { ExcelOperation } from "@pibot/protocol-base/office-ooxml";
import { DOC_REL, type OfficePackage, STRICT_REL } from "../package.ts";
import { type Element, encoder, escapeXml, leafText, type XmlPart } from "../xml.ts";
import {
  type Area,
  addRelated,
  address,
  area,
  book,
  cellIndex,
  columnName,
  nextPart,
  relation,
  sheetPart,
} from "./model.ts";
import {
  bookOrder,
  children,
  replace,
  SS,
  setChild,
  ss,
  tag,
  unique,
  withAttrs,
} from "./xml-edit.ts";

type Grid = (string | number | null)[][];
type Cell = string | number | null;

/** 新部件的第一个关系 id 是确定的：先算出来，才能把 r:id 写进要生成的 XML。 */
function nextRelId(pkg: OfficePackage, source: string) {
  const ids = new Set(pkg.relationships(source).map((rel) => rel.id));
  let n = 1;
  while (ids.has(`rId${n}`)) n++;
  return `rId${n}`;
}

/** 与 model.values 相同，但整块读取；透视需要一次拿到源区域的所有行。 */
function grid(pkg: OfficePackage, sheet: string, a: Area): Grid {
  const { xml } = sheetPart(pkg, sheet),
    cells = cellIndex(xml),
    b = book(pkg);
  const hasStrings = pkg.relationships(b.part).some((rel) => /\/sharedStrings$/u.test(rel.type));
  const strings = hasStrings ? pkg.xml(relation(pkg, b.part, "sharedStrings")) : undefined;
  const items = strings ? children(strings.root, "si") : [];
  const output: Grid = [];
  for (let row = a.firstRow; row <= a.lastRow; row++) {
    const values: Cell[] = [];
    for (let column = a.firstColumn; column <= a.lastColumn; column++) {
      const cell = cells.get(`${columnName(column)}${row}`),
        raw = cell && leafText(xml, unique(cell, "v") ?? cell);
      const type = cell?.attrs.get("t");
      let value: Cell = null;
      if (cell && type === "inlineStr") value = textOf(cell, xml);
      else if (raw !== undefined && raw !== "") {
        if (type === "s") {
          const item = items[Number(raw)];
          value = item && strings ? textOf(item, strings) : null;
        } else if (type === "e") value = null;
        else if (type === "str" || type === "d") value = raw;
        else {
          const parsed = Number(raw);
          value = Number.isFinite(parsed) ? parsed : null;
        }
      }
      values.push(value);
    }
    output.push(values);
  }
  return output;
}

function textOf(node: Element, source: XmlPart): string {
  if (node.name === "rPh" && node.uri === source.root.uri) return "";
  return node.name === "t"
    ? (leafText(source, node) ?? "")
    : node.children.map((child) => textOf(child, source)).join("");
}

const collator = new Intl.Collator("zh-Hans", { numeric: true });

interface Aggregate {
  sum: number;
  count: number;
}

function aggregateValue(entry: Aggregate, summarize: "sum" | "count" | "average") {
  if (summarize === "count") return entry.count;
  if (summarize === "average") return entry.count === 0 ? 0 : entry.sum / entry.count;
  return entry.sum;
}

function itemKey(value: Cell) {
  return value === null ? "m:" : `${typeof value === "number" ? "n" : "s"}:${value}`;
}

function label(value: Cell) {
  return value === null ? "(空)" : String(value);
}

function cellXml(column: number, row: number, value: Cell) {
  if (value === null) return "";
  const ref = `${columnName(column)}${row}`;
  if (typeof value === "number") return `<c r="${ref}"><v>${value}</v></c>`;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

/** 透视结果直接写成单元格值，这样不刷新透视的阅读器也能看到内容。 */
function writeCells(
  pkg: OfficePackage,
  part: string,
  a: Area,
  cells: { column: number; row: number; value: Cell }[],
  uri: string,
) {
  const xml = pkg.xml(part),
    data = unique(xml.root, "sheetData");
  if (!data) throw new Error("office_invalid");
  const existing = cellIndex(xml);
  for (let row = a.firstRow; row <= a.lastRow; row++)
    for (let column = a.firstColumn; column <= a.lastColumn; column++)
      if (existing.has(`${columnName(column)}${row}`))
        throw new Error("office_excel_range_overlap");
  const byRow = new Map<number, string[]>();
  for (const cell of cells) {
    const element = cellXml(cell.column, cell.row, cell.value);
    if (!element) continue;
    const list = byRow.get(cell.row) ?? [];
    list.push(element);
    byRow.set(cell.row, list);
  }
  const rows = new Map(children(data, "row").map((row) => [Number(row.attrs.get("r")), row]));
  const numbers = new Set([...rows.keys(), ...byRow.keys()]);
  const body = [...numbers]
    .sort((a, b) => a - b)
    .map((number) => {
      const row = rows.get(number),
        added = byRow.get(number);
      if (!added) return row ? xml.source.slice(row.start, row.end) : "";
      const oldCells = row ? children(row, "c") : [];
      const entries = oldCells.map((cell) => ({
        column: address(cell.attrs.get("r") ?? "").column,
        value: xml.source.slice(cell.start, cell.end),
      }));
      for (const value of added)
        entries.push({ column: address(/ r="([^"]+)"/u.exec(value)?.[1] ?? "").column, value });
      const content =
        entries
          .sort((a, b) => a.column - b.column)
          .map((cell) => cell.value)
          .join("") +
        (row
          ? row.children
              .filter((node) => node.name !== "c")
              .map((node) => xml.source.slice(node.start, node.end))
              .join("")
          : "");
      return row ? withAttrs(xml, row, {}, content) : tag("row", content, { r: number });
    })
    .join("");
  pkg.replaceXml(part, replace(xml, data, ss("sheetData", body, {}, uri)));
  const next = pkg.xml(part),
    dimension = unique(next.root, "dimension");
  const old = dimension?.attrs.get("ref");
  const bounds = old ? area(old, Number.MAX_SAFE_INTEGER) : a;
  const ref = `${columnName(Math.min(bounds.firstColumn, a.firstColumn))}${Math.min(bounds.firstRow, a.firstRow)}:${columnName(Math.max(bounds.lastColumn, a.lastColumn))}${Math.max(bounds.lastRow, a.lastRow)}`;
  pkg.replaceXml(part, setChild(next, "dimension", ss("dimension", "", { ref }, uri)));
}

function sharedItems(values: Cell[]) {
  const body = values
    .map((value) =>
      value === null
        ? "<m/>"
        : typeof value === "number"
          ? `<n v="${value}"/>`
          : `<s v="${escapeXml(String(value))}"/>`,
    )
    .join("");
  const numbers = values.some((value) => typeof value === "number");
  const strings = values.some((value) => typeof value === "string");
  const numeric = values.filter((value): value is number => typeof value === "number");
  return tag("sharedItems", body, {
    count: values.length,
    containsMixedTypes: numbers && strings,
    containsNumber: numbers,
    containsString: strings,
    containsBlank: values.includes(null),
    containsSemiMixedTypes: strings,
    containsNonDate: true,
    // Real Excel (2026-11-11) refuses a mixed number/text field of whole numbers marked 0 here.
    containsInteger: numbers && numeric.every(Number.isInteger),
    ...(numbers
      ? {
          minValue: numeric.reduce((a, b) => Math.min(a, b), Infinity),
          maxValue: numeric.reduce((a, b) => Math.max(a, b), -Infinity),
        }
      : {}),
  });
}

export function pivot(pkg: OfficePackage, op: Extract<ExcelOperation, { op: "excel_pivot" }>) {
  // 多级行/列字段要生成嵌套 rowItems/colItems，暂不支持，避免写出 Excel 打不开的透视表。
  if (op.rows.length > 1 || op.columns.length > 1) throw new Error("office_unsupported");
  const source = area(op.source.range, 200_000);
  if (source.lastRow <= source.firstRow) throw new Error("office_invalid");
  const data = grid(pkg, op.source.sheet, source);
  const header = (data[0] ?? []).map((value) => String(value ?? ""));
  if (
    header.some((name) => !name) ||
    new Set(header.map((name) => name.toLowerCase())).size !== header.length
  )
    throw new Error("office_invalid");
  const field = (name: string) => {
    const index = header.findIndex((value) => value.toLowerCase() === name.toLowerCase());
    if (index < 0) throw new Error("office_invalid");
    return index;
  };
  const rowIndex = op.rows[0] === undefined ? -1 : field(op.rows[0]);
  const columnIndex = op.columns[0] === undefined ? -1 : field(op.columns[0]);
  const values = op.values.map((item) => ({ ...item, index: field(item.field) }));
  const filters = op.filters.map((item) => ({
    ...item,
    index: field(item.field),
    keys: new Set(item.values.map(itemKey)),
  }));
  // 同一字段可以既做行字段又做数值字段以外的组合都不行；但同一字段可以同时求和与计数。
  const axis = [rowIndex, columnIndex].filter((index) => index >= 0);
  if (
    new Set([...axis, ...filters.map((filter) => filter.index)]).size !==
    axis.length + filters.length
  )
    throw new Error("office_invalid");
  if (
    values.some((value) =>
      [...axis, ...filters.map((filter) => filter.index)].includes(value.index),
    )
  )
    throw new Error("office_invalid");

  const rows = data.slice(1);
  const included = rows.filter((row) =>
    filters.every((filter) => filter.keys.has(itemKey(row[filter.index] ?? null))),
  );
  const axisKeys = (index: number) => {
    const labels = new Map(
      included.map((row) => {
        const value = row[index] ?? null;
        return [itemKey(value), label(value)] as const;
      }),
    );
    return [...labels].sort((a, b) => collator.compare(a[1], b[1]));
  };
  const rowLabels = new Map(rowIndex < 0 ? [] : axisKeys(rowIndex));
  const columnLabels = new Map(columnIndex < 0 ? [["", ""]] : axisKeys(columnIndex));
  const rowKeys = [...rowLabels.keys()];
  const columnKeys = [...columnLabels.keys()];
  const cells = new Map<string, Aggregate>();
  const columnTotals = new Map<string, Aggregate>();
  for (const row of included) {
    const rowKey = itemKey(row[rowIndex] ?? null),
      columnKey = columnIndex < 0 ? "" : itemKey(row[columnIndex] ?? null);
    values.forEach((value, valueIndex) => {
      const raw = row[value.index];
      if (
        raw === null ||
        raw === undefined ||
        (value.summarize !== "count" && typeof raw !== "number")
      )
        return;
      const key = JSON.stringify([rowKey, columnKey, valueIndex]);
      const entry = cells.get(key) ?? { sum: 0, count: 0 };
      entry.sum += typeof raw === "number" ? raw : 0;
      entry.count += 1;
      cells.set(key, entry);
      const totalKey = JSON.stringify([columnKey, valueIndex]);
      const total = columnTotals.get(totalKey) ?? { sum: 0, count: 0 };
      total.sum += typeof raw === "number" ? raw : 0;
      total.count++;
      columnTotals.set(totalKey, total);
    });
  }
  // 总计直接从源行重算：把各分组结果相加会把同一行重复计入多次。
  const grandTotal = (valueIndex: number) => {
    let sum = 0,
      count = 0;
    for (const row of included) {
      const raw = row[values[valueIndex]?.index ?? -1];
      if (
        raw === null ||
        raw === undefined ||
        (values[valueIndex]?.summarize !== "count" && typeof raw !== "number")
      )
        continue;
      sum += typeof raw === "number" ? raw : 0;
      count += 1;
    }
    return aggregateValue({ sum, count }, values[valueIndex]?.summarize ?? "sum");
  };

  const requestedAnchor = address(op.anchor);
  const anchor = {
    ...requestedAnchor,
    row: requestedAnchor.row + (filters.length ? filters.length + 1 : 0),
  };
  const labelColumns = Number(rowIndex >= 0),
    withColumns = columnIndex >= 0;
  const headerRows = withColumns ? 2 : 1;
  const width =
    Math.max(1, withColumns ? columnKeys.length * values.length : values.length) + labelColumns;
  const height = headerRows + rowKeys.length + 1;
  const target = area(
    `${columnName(anchor.column)}${anchor.row}:${columnName(anchor.column + width - 1)}${anchor.row + height - 1}`,
  );
  const output: { column: number; row: number; value: Cell }[] = [];
  const put = (column: number, row: number, value: Cell) =>
    output.push({ column: anchor.column + column, row: anchor.row + row, value });
  const at = (rowKey: string, columnKey: string, valueIndex: number): Cell =>
    aggregateValue(
      cells.get(JSON.stringify([rowKey, columnKey, valueIndex])) ?? { sum: 0, count: 0 },
      values[valueIndex]?.summarize ?? "sum",
    );
  if (withColumns) {
    for (const [keyIndex, columnKey] of columnKeys.entries())
      for (const [valueIndex, value] of values.entries()) {
        put(
          labelColumns + keyIndex * values.length + valueIndex,
          0,
          columnLabels.get(columnKey) ?? "",
        );
        put(labelColumns + keyIndex * values.length + valueIndex, 1, value.name ?? value.field);
      }
    if (labelColumns) put(0, 1, op.rows[0] ?? "");
    for (const [rowPosition, rowKey] of rowKeys.entries()) {
      put(0, headerRows + rowPosition, rowLabels.get(rowKey) ?? "");
      for (const [keyIndex, columnKey] of columnKeys.entries())
        for (const valueIndex of values.keys()) {
          put(
            labelColumns + keyIndex * values.length + valueIndex,
            headerRows + rowPosition,
            at(rowKey, columnKey, valueIndex),
          );
        }
    }
  } else {
    if (labelColumns) put(0, 0, op.rows[0] ?? "");
    for (const [valueIndex, value] of values.entries())
      put(labelColumns + valueIndex, 0, value.name ?? value.field);
    for (const [rowPosition, rowKey] of rowKeys.entries()) {
      put(0, 1 + rowPosition, rowLabels.get(rowKey) ?? "");
      for (const valueIndex of values.keys()) {
        put(1 + valueIndex, 1 + rowPosition, at(rowKey, "", valueIndex));
      }
    }
  }
  const grandRow = headerRows + rowKeys.length;
  if (labelColumns) put(0, grandRow, "总计");
  for (const valueIndex of values.keys()) {
    if (withColumns) {
      for (const [keyIndex, key] of columnKeys.entries()) {
        const aggregate = columnTotals.get(JSON.stringify([key, valueIndex])) ?? {
          sum: 0,
          count: 0,
        };
        put(
          labelColumns + keyIndex * values.length + valueIndex,
          grandRow,
          aggregateValue(aggregate, values[valueIndex]?.summarize ?? "sum"),
        );
      }
    } else put(labelColumns + valueIndex, grandRow, grandTotal(valueIndex));
  }

  const { part, xml } = sheetPart(pkg, op.sheet);
  for (const [i, filter] of filters.entries()) {
    output.push(
      { column: requestedAnchor.column, row: requestedAnchor.row + i, value: filter.field },
      {
        column: requestedAnchor.column + 1,
        row: requestedAnchor.row + i,
        value: filter.values.map(label).join(", "),
      },
    );
  }
  const occupied = area(
    `${columnName(requestedAnchor.column)}${requestedAnchor.row}:${columnName(Math.max(target.lastColumn, requestedAnchor.column + Number(filters.length > 0)))}${target.lastRow}`,
  );
  writeCells(pkg, part, occupied, output, xml.root.uri);

  const b = book(pkg);
  const caches = unique(b.xml.root, "pivotCaches");
  const ids = (caches ? children(caches, "pivotCache") : []).map((node) =>
    Number(node.attrs.get("cacheId")),
  );
  const cacheId = Math.max(0, ...ids, 0) + 1;
  const defined = unique(b.xml.root, "definedNames");
  if (
    defined &&
    children(defined, "definedName").some(
      (name) => name.attrs.get("name")?.toLowerCase() === op.name.toLowerCase(),
    )
  )
    throw new Error("office_target_ambiguous");

  const cachePart = nextPart(pkg, "xl/pivotCache/pivotCacheDefinition"),
    recordsPart = nextPart(pkg, "xl/pivotCache/pivotCacheRecords"),
    tablePart = nextPart(pkg, "xl/pivotTables/pivotTable");
  const relNs = b.xml.root.uri === SS ? DOC_REL : STRICT_REL;
  const relative = (from: string, to: string) => posix.relative(posix.dirname(from), to);
  const recordsId = nextRelId(pkg, cachePart);
  const shared = (index: number) => {
    return [...new Set(rows.map((row) => row[index] ?? null))];
  };
  const sharedValues = header.map((_, index) => shared(index));
  const sharedIndexes = sharedValues.map(
    (values) => new Map(values.map((value, i) => [itemKey(value), i])),
  );
  // Real Excel (2026-11-11) crashes refreshing on load when one field holds a number and a text
  // of the same spelling (1 and "1") and a filter keeps the text one. The written cache and the
  // result cells are already complete, so such a workbook just opens without the refresh.
  const ambiguous = sharedValues.some((values) => {
    const numbers = new Set(
      values.filter((value) => typeof value === "number").map((value) => String(value)),
    );
    return values.some((value) => typeof value === "string" && numbers.has(value.trim()));
  });
  const cacheFields = header
    .map((name, index) =>
      tag("cacheField", sharedItems(sharedValues[index] ?? []), { name, numFmtId: 0 }),
    )
    .join("");
  pkg.addPart(
    cachePart,
    encoder.encode(
      ss(
        "pivotCacheDefinition",
        tag(
          "cacheSource",
          tag("worksheetSource", "", { ref: source.ref, sheet: op.source.sheet }),
          {
            type: "worksheet",
          },
        ) + tag("cacheFields", cacheFields, { count: header.length }),
        {
          "xmlns:r": relNs,
          "r:id": recordsId,
          refreshOnLoad: !ambiguous,
          createdVersion: 3,
          refreshedVersion: 3,
          minRefreshableVersion: 3,
          recordCount: rows.length,
        },
        xml.root.uri,
      ),
    ),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml",
  );
  pkg.addPart(
    recordsPart,
    encoder.encode(
      ss(
        "pivotCacheRecords",
        // A field with sharedItems uses indexes in every record, including numeric measures.
        rows
          .map((row) =>
            tag(
              "r",
              header
                .map((_, i) => tag("x", "", { v: sharedIndexes[i]?.get(itemKey(row[i] ?? null)) }))
                .join(""),
            ),
          )
          .join(""),
        { count: rows.length },
        xml.root.uri,
      ),
    ),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheRecords+xml",
  );
  pkg.addRelationship(
    cachePart,
    recordsId,
    `${relNs}/pivotCacheRecords`,
    relative(cachePart, recordsPart),
  );
  const cacheRel = addRelated(pkg, b.part, cachePart, "pivotCacheDefinition");
  const tableId = nextRelId(pkg, part);
  const tableCacheId = nextRelId(pkg, tablePart);
  // x in rowItems/colItems indexes pivotField.items, which in turn indexes sharedItems.
  const axisItems = (index: number, keys: string[]) => {
    const indexes = sharedIndexes[index];
    return keys
      .map((key) =>
        tag("item", "", {
          x: indexes?.get(key),
        }),
      )
      .join("");
  };
  const rowItems =
    rowKeys.map((_, index) => tag("i", tag("x", "", { v: index }))).join("") +
    (rowIndex >= 0 ? tag("i", tag("x"), { t: "grand" }) : tag("i"));
  const columnItems = (withColumns ? columnKeys : [""])
    .flatMap((_, index) =>
      values.map((_, valueIndex) =>
        tag(
          "i",
          (withColumns ? tag("x", "", { v: index }) : values.length === 1 ? tag("x") : "") +
            (values.length > 1 ? tag("x", "", { v: valueIndex }) : ""),
          { i: valueIndex },
        ),
      ),
    )
    .join("");
  const pivotFields = header
    .map((_, index) => {
      if (index === rowIndex)
        return tag(
          "pivotField",
          tag("items", axisItems(index, rowKeys) + tag("item", "", { t: "default" }), {
            count: rowKeys.length + 1,
          }),
          { axis: "axisRow", compact: false, outline: true, showAll: false },
        );
      if (index === columnIndex)
        return tag(
          "pivotField",
          tag("items", axisItems(index, columnKeys), { count: columnKeys.length }),
          { axis: "axisCol", compact: false, defaultSubtotal: false, showAll: false },
        );
      if (filters.some((filter) => filter.index === index))
        return tag(
          "pivotField",
          tag(
            "items",
            (sharedValues[index] ?? [])
              .map((value, x) =>
                tag("item", "", {
                  x,
                  h: !filters.find((filter) => filter.index === index)?.keys.has(itemKey(value)),
                }),
              )
              // Real Excel (2026-11-11) refuses a page field without the closing default item.
              .join("") + tag("item", "", { t: "default" }),
            { count: (sharedValues[index]?.length ?? 0) + 1 },
          ),
          { axis: "axisPage", multipleItemSelectionAllowed: true, showAll: false },
        );
      if (values.some((value) => value.index === index))
        return tag("pivotField", "", { dataField: true, showAll: false });
      return tag("pivotField", "", { showAll: false });
    })
    .join("");
  const totals = (summarize: string) =>
    summarize === "sum" ? "求和项" : summarize === "count" ? "计数项" : "平均值项";
  pkg.addPart(
    tablePart,
    encoder.encode(
      ss(
        "pivotTableDefinition",
        tag("location", "", {
          ref: target.ref,
          firstHeaderRow: 0,
          firstDataRow: headerRows,
          firstDataCol: labelColumns,
          ...(filters.length ? { rowPageCount: filters.length, colPageCount: 1 } : {}),
        }) +
          tag("pivotFields", pivotFields, { count: header.length }) +
          (rowIndex >= 0 ? tag("rowFields", tag("field", "", { x: rowIndex }), { count: 1 }) : "") +
          tag("rowItems", rowItems, { count: rowKeys.length + 1 }) +
          (withColumns || values.length > 1
            ? tag(
                "colFields",
                (withColumns ? tag("field", "", { x: columnIndex }) : "") +
                  (values.length > 1 ? tag("field", "", { x: -2 }) : ""),
                { count: Number(withColumns) + Number(values.length > 1) },
              )
            : "") +
          tag("colItems", columnItems, {
            count: (withColumns ? columnKeys.length : 1) * values.length,
          }) +
          (filters.length
            ? tag(
                "pageFields",
                filters
                  .map((filter) => tag("pageField", "", { fld: filter.index, hier: -1 }))
                  .join(""),
                { count: filters.length },
              )
            : "") +
          tag(
            "dataFields",
            values
              .map((value) =>
                tag("dataField", "", {
                  name: value.name ?? `${totals(value.summarize)}:${value.field}`,
                  fld: value.index,
                  baseField: 0,
                  baseItem: 0,
                  subtotal: value.summarize,
                }),
              )
              .join(""),
            { count: values.length },
          ) +
          tag("pivotTableStyleInfo", "", {
            name: "PivotStyleLight16",
            showRowHeaders: true,
            showColHeaders: true,
            showRowStripes: false,
            showColStripes: false,
            showLastColumn: true,
          }),
        {
          name: op.name,
          cacheId,
          applyNumberFormats: false,
          applyBorderFormats: false,
          applyFontFormats: false,
          applyPatternFormats: false,
          applyAlignmentFormats: false,
          applyWidthHeightFormats: true,
          dataCaption: "值",
          updatedVersion: 3,
          createdVersion: 3,
          minRefreshableVersion: 3,
          itemPrintTitles: true,
          indent: 0,
          outline: true,
          outlineData: true,
          compact: false,
          compactData: false,
          rowGrandTotals: false,
          colGrandTotals: true,
        },
        xml.root.uri,
      ),
    ),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml",
  );
  pkg.addRelationship(part, tableId, `${relNs}/pivotTable`, relative(part, tablePart));
  pkg.addRelationship(
    tablePart,
    tableCacheId,
    `${relNs}/pivotCacheDefinition`,
    relative(tablePart, cachePart),
  );
  // workbook 里的 pivotCaches 让 Excel 找到缓存定义；关系 id 用新分配的那个。
  const workbook = book(pkg);
  const cacheEntry = ss(
    "pivotCache",
    "",
    { cacheId, "xmlns:r": cacheRel.ns, "r:id": cacheRel.id },
    workbook.xml.root.uri,
  );
  const parent = unique(workbook.xml.root, "pivotCaches");
  let workbookSource = workbook.xml.source;
  const existing = parent ? children(parent, "pivotCache") : [];
  const merged = ss(
    "pivotCaches",
    existing.map((node) => workbook.xml.source.slice(node.start, node.end)).join("") + cacheEntry,
    {},
    workbook.xml.root.uri,
  );
  workbookSource = parent
    ? replace(workbook.xml, parent, merged)
    : setChild(workbook.xml, "pivotCaches", merged, bookOrder);
  // Each cache entry declares r locally; rewriting the workbook root here would reuse stale
  // offsets after inserting pivotCaches and truncate workbooks with only locally declared r.
  pkg.replaceXml(workbook.part, workbookSource);
}
