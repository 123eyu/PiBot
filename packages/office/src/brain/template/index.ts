import { blocksPublication, OfficePackage, validatePackage } from "../ooxml/index.ts";
import { TemplateBudget } from "./budget.ts";
import type { TemplateField, TemplateValue } from "./engine.ts";
import { excelFields, excelFill } from "./excel.ts";
import { pptFields, pptFill } from "./presentation.ts";
import { wordFields, wordFill } from "./word.ts";

export type TemplateFormat = "docx" | "xlsx" | "pptx";

export interface TemplateScan {
  format: TemplateFormat;
  fields: TemplateField[];
  warnings: string[];
}

export interface TemplateResult extends TemplateScan {
  replacements: number;
  loops: number;
  blocks: number;
}

/** Lists placeholders without writing: the read-only tool answers before any fill is attempted. */
export function scanTemplate(
  pkg: OfficePackage,
  format: TemplateFormat,
  budget = new TemplateBudget(),
): TemplateScan {
  const stats =
    format === "docx"
      ? wordFields(pkg, budget)
      : format === "pptx"
        ? pptFields(pkg, budget)
        : excelFields(pkg, budget);
  return { format, fields: stats.fields, warnings: [...new Set(stats.warnings)] };
}

export async function templateFields(bytes: Uint8Array, format: TemplateFormat) {
  return scanTemplate(await OfficePackage.open(bytes), format);
}

export async function templateFill(
  bytes: Uint8Array,
  format: TemplateFormat,
  data: TemplateValue,
  acceptValidationErrors = false,
) {
  const pkg = await OfficePackage.open(bytes);
  const budget = new TemplateBudget();
  const stats =
    format === "docx"
      ? wordFill(pkg, data, budget)
      : format === "pptx"
        ? pptFill(pkg, data, budget)
        : excelFill(pkg, data, budget);
  const scan = scanTemplate(pkg, format, budget);
  const validation = validatePackage(pkg, format);
  if (blocksPublication(validation, acceptValidationErrors)) return { validation, scan };
  const candidate = pkg.write();
  // Reopening proves the result still satisfies the archive limits before it is published.
  await OfficePackage.open(candidate);
  return {
    validation,
    bytes: candidate,
    scan,
    replacements: stats.replacements,
    loops: stats.loops,
    blocks: "slides" in stats ? stats.slides : "rows" in stats ? stats.rows : 0,
  };
}
