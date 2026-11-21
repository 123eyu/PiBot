import type { OfficeCell, OfficeContent } from "@pibot/office-contract/full";

// Mirrors OfficeContentSchema bounds so callers get office_content_limit instead of a generic
// schema error after the worker has already produced the document.
const MAX_TEXT = 100_000;
const MAX_BLOCKS = 2_000;
const MAX_TABLE_ROWS = 1_000;
const MAX_TABLE_COLUMNS = 50;
const MAX_TABLE_CELL = 10_000;
const MAX_SLIDES = 200;
const MAX_SLIDE_TITLE = 500;

/**
 * Markdown we emit is rendered as HTML in previews, so escaping belongs only on the output side.
 * Escaping on the input side would put "R&amp;D" into Word.
 */
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plainInline(value: string): string {
  return (
    value
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\*\*([^*\n]+)\*\*/g, "$1")
      .replace(/__([^_\n]+)__/g, "$1")
      // A single marker only emphasises at word boundaries; otherwise snake_case loses underscores.
      .replace(/(^|[^\p{L}\p{N}_*])\*([^*\n]+)\*(?![\p{L}\p{N}_*])/gu, "$1$2")
      .replace(/(^|[^\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, "$1$2")
  );
}

function inlineText(value: string): string {
  return escapeHtml(plainInline(value));
}

function tableCell(value: string): string {
  return escapeHtml(
    plainInline(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>"),
  );
}

function markdownTable(rows: string[][]): string[] {
  const header = rows[0];
  if (!header) return [];
  const width = Math.max(...rows.map((row) => row.length));
  const cells = rows.map((row) => [...row, ...Array<string>(width - row.length).fill("")]);
  return [
    `| ${cells[0]?.map((cell) => tableCell(cell) || " ").join(" | ") ?? ""} |`,
    `| ${Array<string>(width).fill("---").join(" | ")} |`,
    ...cells.slice(1).map((row) => `| ${row.map((cell) => tableCell(cell) || " ").join(" | ")} |`),
  ];
}

export function docxToMarkdown(content: OfficeContent): string {
  if (content.kind !== "docx") throw new Error("office_invalid");
  const parts: string[] = [];
  if (content.title) parts.push(`# ${inlineText(content.title)}`);
  for (const block of content.blocks) {
    if (block.type === "heading")
      parts.push(`${"#".repeat(block.level)} ${inlineText(block.text)}`);
    else if (block.type === "paragraph")
      parts.push(
        block.image
          ? `![${inlineText(block.text)}](image:${block.image.path})`
          : inlineText(block.text),
      );
    else parts.push(markdownTable(block.rows).join("\n"));
  }
  return `${parts.filter((part) => part.length > 0).join("\n\n")}\n`;
}

export function pptxToMarkdown(content: OfficeContent): string {
  if (content.kind !== "pptx") throw new Error("office_invalid");
  const parts: string[] = [
    `# ${inlineText(content.title ?? content.slides[0]?.title ?? "Presentation")}`,
  ];
  for (const slide of content.slides) {
    if (slide.title) parts.push(`## ${inlineText(slide.title)}`);
    const lines = (slide.text ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length) parts.push(lines.map((line) => `- ${inlineText(line)}`).join("\n"));
  }
  return `${parts.join("\n\n")}\n`;
}

function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of inner) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\") escaped = true;
    else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else current += char;
  }
  cells.push(current.trim());
  return cells.map((cell) => cell.replace(/<br\s*\/?>/gi, "\n"));
}

const separator = /^:?-{1,}:?$/;

// OfficeContent has no list block, so list items become paragraphs with a bullet glyph; nesting
// keeps two spaces per level so the hierarchy stays readable in Word.
function listText(indent: string, text: string): string {
  const level = Math.min(3, Math.floor(indent.length / 2));
  return `${"  ".repeat(level)}${level === 0 ? "•" : "◦"} ${text}`;
}

function checked(text: string): string {
  if (text.length > MAX_TEXT) throw new Error("office_content_limit");
  return text;
}

export function markdownToDocx(markdown: string): OfficeContent {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Extract<OfficeContent, { kind: "docx" }>["blocks"] = [];
  const push = (block: Extract<OfficeContent, { kind: "docx" }>["blocks"][number]) => {
    if (blocks.length >= MAX_BLOCKS) throw new Error("office_content_limit");
    blocks.push(block);
  };
  let paragraph: string[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    const text = paragraph.join("\n").trim();
    if (text) push({ type: "paragraph", text: checked(text) });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (index += 1; index < lines.length; index += 1) {
        const next = lines[index] ?? "";
        if (/^\s*```/.test(next)) break;
        code.push(next);
      }
      if (code.length) push({ type: "paragraph", text: checked(code.join("\n")) });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      push({
        type: "heading",
        level: heading[1]?.length ?? 1,
        text: checked(plainInline(heading[2] ?? "")),
      });
      continue;
    }
    if (line.trim().startsWith("|")) {
      flush();
      const rows: string[][] = [];
      while (index < lines.length) {
        const next = lines[index] ?? "";
        if (!next.trim().startsWith("|")) break;
        const cells = splitRow(next);
        if (!cells.every((cell) => separator.test(cell))) rows.push(cells);
        index += 1;
      }
      index -= 1;
      if (rows.length) {
        if (rows.length > MAX_TABLE_ROWS) throw new Error("office_content_limit");
        for (const row of rows) {
          if (row.length > MAX_TABLE_COLUMNS) throw new Error("office_content_limit");
          for (const cell of row) {
            if (cell.length > MAX_TABLE_CELL) throw new Error("office_content_limit");
          }
        }
        push({ type: "table", rows });
      }
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      push({
        type: "paragraph",
        text: checked(listText(bullet[1] ?? "", plainInline(bullet[2] ?? ""))),
      });
      continue;
    }
    paragraph.push(plainInline(line));
  }
  flush();
  if (!blocks.length) throw new Error("office_invalid");
  return { kind: "docx", blocks };
}

/** The outline format mirrors what pptx → Markdown emits, so a round trip keeps titles and bullets. */
export function markdownToPptx(markdown: string): OfficeContent {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const slides: { title?: string; text: string[] }[] = [];
  let deckTitle: string | undefined;
  let current: { title?: string; text: string[] } | undefined;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const title = plainInline(heading[2] ?? "");
      if (title.length > MAX_SLIDE_TITLE || slides.length >= MAX_SLIDES)
        throw new Error("office_content_limit");
      const next = { title, text: [] as string[] };
      slides.push(next);
      current = next;
      if ((heading[1]?.length ?? 1) === 1 && !deckTitle) deckTitle = title;
      continue;
    }
    const text = plainInline(line.trim().replace(/^[-*+]\s+/, ""));
    if (!text) continue;
    if (!current) {
      if (slides.length >= MAX_SLIDES) throw new Error("office_content_limit");
      current = { text: [] };
      slides.push(current);
    }
    current.text.push(text);
  }
  const limited = slides
    .filter((slide) => slide.title !== undefined || slide.text.length > 0)
    .map((slide) => {
      const text = checked(slide.text.join("\n"));
      return {
        ...(slide.title !== undefined ? { title: slide.title } : {}),
        ...(text ? { text } : {}),
      };
    });
  if (!limited.length) throw new Error("office_invalid");
  return { kind: "pptx", ...(deckTitle ? { title: deckTitle } : {}), slides: limited };
}

// Excel runs a field that starts with one of these as a formula (or a DDE command) when it opens
// a CSV, so text cells and uncached formulas are neutralised with an apostrophe prefix.
const CSV_RISKY = /^[=+\-@\t\r]/;
function csvGuard(value: string): string {
  return CSV_RISKY.test(value) ? `'${value}` : value;
}
function csvQuote(value: string): string {
  return /[",\r\n\t]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
function csvValue(cell: OfficeCell): string {
  if (cell === null) return "";
  // Negative numbers stay numbers; only strings need the formula guard.
  if (typeof cell === "number") return String(cell);
  if (typeof cell === "boolean") return cell ? "TRUE" : "FALSE";
  if (typeof cell === "string") return csvQuote(csvGuard(cell));
  return cell.cachedValue !== undefined
    ? csvValue(cell.cachedValue)
    : csvQuote(csvGuard(`=${cell.formula}`));
}

// CON, NUL, COM1… are device names on Windows; a sheet may legitimately be called CON.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function xlsxToCsv(content: OfficeContent): { name: string; text: string }[] {
  if (content.kind !== "xlsx") throw new Error("office_invalid");
  const used = new Set<string>();
  return content.sheets.map((sheet, index) => {
    let name = sheet.name
      .replace(/[\\/:*?"<>|\p{Cc}]/gu, "_")
      .replace(/[. ]+$/, "")
      .slice(0, 60);
    if (!name) name = `Sheet ${index + 1}`;
    if (WINDOWS_DEVICE.test(name)) name = `_${name}`;
    let unique = name;
    for (let suffix = 2; used.has(unique.toLowerCase()); suffix += 1)
      unique = `${name} (${suffix})`;
    used.add(unique.toLowerCase());
    const rows = sheet.rows.map((row) => row.map((cell) => csvValue(cell)).join(","));
    // The BOM lets Windows Excel detect UTF-8 and keeps an empty sheet a non-empty file.
    return { name: `${unique}.csv`, text: `\uFEFF${rows.join("\r\n")}` };
  });
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (index < text.length) {
    const char = text.charAt(index);
    if (quoted) {
      if (char === '"') {
        if (text.charAt(index + 1) === '"') {
          field += '"';
          index += 2;
        } else {
          quoted = false;
          index += 1;
        }
      } else {
        field += char;
        index += 1;
      }
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
      index += 1;
    } else if (char === ",") {
      pushField();
      index += 1;
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text.charAt(index + 1) === "\n") index += 1;
      pushRow();
      index += 1;
    } else {
      field += char;
      index += 1;
    }
  }
  if (field !== "" || row.length) pushRow();
  const last = rows.at(-1);
  if (rows.length > 1 && last?.length === 1 && last[0] === "") rows.pop();
  return rows;
}

function sheetName(name: string): string {
  const base = name
    .replace(/\.[^.]+$/, "")
    .replace(/[[\]:*?/\\]/g, " ")
    .trim();
  return (base || "Sheet1").slice(0, 31);
}

export function csvToXlsx(name: string, text: string): OfficeContent {
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  if (
    rows.length > 5_000 ||
    rows.some((row) => row.length > 100) ||
    rows.flat().some((cell) => cell.length > 10_000)
  )
    throw new Error("office_content_limit");
  return { kind: "xlsx", sheets: [{ name: sheetName(name), rows }] };
}
