import type { ExcelOperation } from "@pibot/protocol-base/office-ooxml";
import type { OfficePackage } from "../package.ts";
import { chart } from "./charts.ts";
import { dimensions, formatCells } from "./format.ts";
import { definedName } from "./names.ts";
import { pivot } from "./pivot.ts";
import { table } from "./tables.ts";
import { conditional, validation } from "./validation.ts";
import { merge, view } from "./view.ts";

export function applyExcel(pkg: OfficePackage, operation: ExcelOperation) {
  switch (operation.op) {
    case "excel_format":
      return formatCells(pkg, operation);
    case "excel_dimensions":
      return dimensions(pkg, operation);
    case "excel_merge":
      return merge(pkg, operation);
    case "excel_view":
      return view(pkg, operation);
    case "excel_conditional_format":
      return conditional(pkg, operation);
    case "excel_validation":
      return validation(pkg, operation);
    case "excel_defined_name":
      return definedName(pkg, operation.name, operation.source);
    case "excel_table":
      return table(pkg, operation);
    case "excel_chart":
      return chart(pkg, operation);
    case "excel_pivot":
      return pivot(pkg, operation);
  }
}
