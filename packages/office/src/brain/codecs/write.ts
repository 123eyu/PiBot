import type { OfficeContent } from "@pibot/office-contract/full";
import {
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import ExcelJS from "exceljs";
import { FormulaBook } from "../formula/engine.ts";
import { ALLOWED_FUNCTIONS } from "../formula/functions/index.ts";
import { cellName } from "../formula/value.ts";
import { writePresentation } from "../ooxml/presentation/index.ts";
import { wordImageType } from "../ooxml/word/image.ts";
export function validateContent(content: OfficeContent): void {
  if (new TextEncoder().encode(JSON.stringify(content)).byteLength > 2 * 1024 * 1024)
    throw new Error("office_content_limit");
  if (content.kind === "xlsx") {
    const names = new Set<string>();
    let cells = 0;
    for (const sheet of content.sheets) {
      if (
        /[\\/?:*[\]]/.test(sheet.name) ||
        sheet.name.startsWith("'") ||
        sheet.name.endsWith("'") ||
        names.has(sheet.name.toLowerCase())
      )
        throw new Error("office_invalid_sheet_name");
      names.add(sheet.name.toLowerCase());
      for (const row of sheet.rows) {
        cells += row.length;
        for (const cell of row)
          if (cell !== null && typeof cell === "object") validateFormula(cell.formula);
      }
    }
    if (cells > 100_000) throw new Error("office_content_limit");
  }
}
function validateFormula(formula: string): void {
  // Formulas are explicit data only; network, dynamic references and unknown functions are refused.
  if (/[[\]|{};@\\\r\n]|https?:|file:|ftp:|DDE/i.test(formula) || formula.startsWith("="))
    throw new Error("office_unsafe_formula");
  const unquoted = formula.replace(/"(?:[^"]|"")*"/g, '""');
  for (const match of unquoted.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g))
    if (!ALLOWED_FUNCTIONS.has((match[1] ?? "").toUpperCase()))
      throw new Error("office_unsafe_formula");
}
export async function writeContent(
  content: OfficeContent,
  images: Record<string, Uint8Array> = {},
  retainedTemplateParts?: Set<string>,
): Promise<Uint8Array> {
  validateContent(content);
  if (content.kind === "docx") return writeDocx(content, images);
  if (content.kind === "xlsx") return writeXlsx(content);
  return writePresentation(content, images, retainedTemplateParts);
}
async function writeDocx(
  content: Extract<OfficeContent, { kind: "docx" }>,
  images: Record<string, Uint8Array>,
): Promise<Uint8Array> {
  const headings = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ] as const;
  const children: (Paragraph | Table)[] = [];
  if (content.title)
    children.push(
      new Paragraph({ text: content.title, heading: HeadingLevel.TITLE, spacing: { after: 320 } }),
    );
  for (const block of content.blocks) {
    if (block.type === "table")
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: block.rows.map(
            (row, index) =>
              new TableRow({
                tableHeader: index === 0,
                children: row.map(
                  (text) =>
                    new TableCell({
                      shading: index === 0 ? { fill: "EAF0F8" } : undefined,
                      children: [
                        new Paragraph({ children: [new TextRun({ text, bold: index === 0 })] }),
                      ],
                    }),
                ),
              }),
          ),
        }),
      );
    else
      children.push(
        new Paragraph({
          children: [
            ...(block.type === "paragraph" && block.image
              ? [
                  new ImageRun({
                    data:
                      images[block.image.path] ??
                      (() => {
                        throw new Error("office_invalid");
                      })(),
                    type: wordImageType(images[block.image.path]),
                    transformation: { width: block.image.width, height: block.image.height },
                    altText: { title: "Chart", description: block.text, name: "Chart" },
                  }),
                ]
              : []),
            new TextRun({ text: block.text }),
          ],
          ...(block.type === "heading"
            ? { heading: headings[block.level - 1] ?? HeadingLevel.HEADING_1 }
            : {}),
          spacing: { after: block.type === "heading" ? 180 : 140 },
        }),
      );
  }
  const doc = new Document({
    creator: "PiBot",
    title: content.title,
    styles: {
      default: {
        document: {
          run: { font: "Arial", size: 22, color: "202838" },
          paragraph: { spacing: { line: 300 } },
        },
      },
    },
    sections: [
      {
        properties: { page: { margin: { top: 1_080, bottom: 1_080, left: 1_080, right: 1_080 } } },
        children,
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}
/** Font metrics vary by Office app; count East Asian/emoji width conservatively instead of UTF-16 units. */
export function estimatedXlsxTextHeight(value: string): number {
  const lines = value.split(/\r\n|\r|\n/).reduce((total, line) => {
    let width = 0;
    for (const char of line) {
      if (/[\p{Mark}\p{Format}]/u.test(char)) continue;
      width +=
        char === "\t"
          ? 4
          : /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}\uFF01-\uFF60\uFFE0-\uFFE6]/u.test(
                char,
              )
            ? 2
            : 1;
    }
    return total + Math.max(1, Math.ceil(width / 20));
  }, 0);
  return lines * 16 + 4;
}

async function writeXlsx(content: Extract<OfficeContent, { kind: "xlsx" }>): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PiBot";
  workbook.calcProperties.fullCalcOnLoad = true;
  // 公式结果在写入时算出，其它阅读器不必自己重算；算不出来的留给 Excel（calcProperties 已设全量重算）。
  const results = new FormulaBook(content.sheets).results();
  for (const input of content.sheets) {
    const sheet = workbook.addWorksheet(input.name, { views: [{ state: "frozen", ySplit: 1 }] });
    input.rows.forEach((row) => {
      const values = row.map((cell, column) => {
        if (cell === null || typeof cell !== "object") return cell;
        const computed = results.get(
          `${input.name}!${cellName({ column: column + 1, row: sheet.rowCount + 1 })}`,
        );
        const result = computed?.value ?? cell.cachedValue;
        return { formula: cell.formula, ...(result !== undefined ? { result } : {}) };
      });
      sheet.addRow(values);
    });
    sheet.eachRow((row, index) => {
      let height = index === 1 ? 26 : 20;
      row.eachCell((cell) => {
        height = Math.max(height, estimatedXlsxTextHeight(String(cell.text)));
      });
      // Microsoft documents 409 points as the maximum row height; values remain intact beyond it.
      row.height = Math.min(409, height);
      row.font = {
        name: "Arial",
        size: 11,
        ...(index === 1 ? { bold: true, color: { argb: "FFFFFFFF" } } : {}),
      };
      row.alignment = { vertical: "middle", wrapText: true };
      if (index === 1)
        row.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF244568" } };
        });
    });
    // ExcelJS does not allocate columns until a non-empty row is added.
    for (const column of sheet.columns ?? []) column.width = 22;
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
