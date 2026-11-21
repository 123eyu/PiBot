import { z } from "zod";

const text = z.string().min(1).max(255);
const sheet = text.max(31).regex(/^(?!')(?!.*'$)[^[\]:*?/\\\p{Cc}]+$/u);
const _cell = z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}$/u);
const range = z
  .string()
  .max(35)
  .regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}(?::[A-Z]{1,3}[1-9][0-9]{0,6})?$/u);
const color = z.string().regex(/^[0-9a-fA-F]{6}$/u);
const borderSide = z.strictObject({
  style: z.enum(["thin", "medium", "thick", "dashed", "dotted", "double"]),
  color: color.optional(),
});
export const ExcelStyleSchema = z.strictObject({
  numberFormat: z.string().min(1).max(255).optional(),
  font: z
    .strictObject({
      name: text.optional(),
      size: z.number().min(1).max(409).optional(),
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      underline: z.boolean().optional(),
      color: color.optional(),
    })
    .optional(),
  fill: color.optional(),
  alignment: z
    .strictObject({
      horizontal: z
        .enum([
          "general",
          "left",
          "center",
          "right",
          "fill",
          "justify",
          "centerContinuous",
          "distributed",
        ])
        .optional(),
      vertical: z.enum(["top", "center", "bottom", "justify", "distributed"]).optional(),
      wrapText: z.boolean().optional(),
      textRotation: z.number().int().min(0).max(180).optional(),
      indent: z.number().int().min(0).max(250).optional(),
    })
    .optional(),
  border: z
    .strictObject({
      left: borderSide.optional(),
      right: borderSide.optional(),
      top: borderSide.optional(),
      bottom: borderSide.optional(),
    })
    .optional(),
});
const ref = z.strictObject({ sheet, range });
const series = z.strictObject({
  name: text,
  values: ref,
  categories: ref.optional(),
  xValues: ref.optional(),
  color: color.optional(),
  kind: z.enum(["column", "line", "area"]).optional(),
});
const operator = z.enum([
  "between",
  "notBetween",
  "equal",
  "notEqual",
  "lessThan",
  "lessThanOrEqual",
  "greaterThan",
  "greaterThanOrEqual",
]);
const threshold = z.number().finite();
const conditionalRule = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("colorScale"), colors: z.array(color).min(2).max(3) }),
  z.strictObject({ kind: z.literal("dataBar"), color }),
  z.strictObject({
    kind: z.literal("cellIs"),
    operator,
    values: z.array(threshold).min(1).max(2),
    style: ExcelStyleSchema,
  }),
]);
const validation = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("list"),
    values: z
      .array(
        z
          .string()
          .min(1)
          .max(255)
          .regex(/^[^,\r\n"]+$/u),
      )
      .min(1)
      .max(100),
  }),
  z.strictObject({ kind: z.literal("listRange"), source: ref }),
  z.strictObject({
    kind: z.enum(["whole", "decimal", "date"]),
    operator,
    values: z.array(threshold).min(1).max(2),
  }),
]);
export const ExcelOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("excel_format"), sheet, range, style: ExcelStyleSchema }),
  z.strictObject({
    op: z.literal("excel_dimensions"),
    sheet,
    columns: z
      .array(
        z.strictObject({
          first: z.number().int().min(1).max(16384),
          last: z.number().int().min(1).max(16384),
          width: z.number().min(0).max(255),
        }),
      )
      .max(100)
      .optional(),
    rows: z
      .array(
        z.strictObject({
          first: z.number().int().min(1).max(1048576),
          last: z.number().int().min(1).max(1048576),
          height: z.number().min(0).max(409),
        }),
      )
      .max(100)
      .optional(),
  }),
  z.strictObject({ op: z.literal("excel_merge"), sheet, range, merge: z.boolean().default(true) }),
  z.strictObject({
    op: z.literal("excel_view"),
    sheet,
    frozenRows: z.number().int().min(0).max(1048575).optional(),
    frozenColumns: z.number().int().min(0).max(16383).optional(),
    autoFilter: z.union([range, z.literal(false)]).optional(),
  }),
  z.strictObject({
    op: z.literal("excel_conditional_format"),
    sheet,
    range,
    rule: conditionalRule,
  }),
  z.strictObject({
    op: z.literal("excel_validation"),
    sheet,
    range,
    validation,
    allowBlank: z.boolean().default(true),
    errorTitle: text.max(32).optional(),
    error: z.string().max(225).optional(),
  }),
  z.strictObject({
    op: z.literal("excel_defined_name"),
    name: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z_\\][A-Za-z0-9_.\\]*$/u),
    source: ref,
  }),
  z.strictObject({
    op: z.literal("excel_table"),
    sheet,
    range,
    name: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
    columns: z.array(text).min(1).max(256),
    style: z
      .enum(["TableStyleMedium2", "TableStyleMedium9", "TableStyleLight1", "TableStyleDark1"])
      .default("TableStyleMedium2"),
  }),
  z.strictObject({
    op: z.literal("excel_pivot"),
    source: ref,
    sheet,
    anchor: _cell,
    name: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
    rows: z.array(text).max(16).default([]),
    columns: z.array(text).max(16).default([]),
    values: z
      .array(
        z.strictObject({
          field: text,
          summarize: z.enum(["sum", "count", "average"]).default("sum"),
          name: text.optional(),
        }),
      )
      .min(1)
      .max(16),
    filters: z
      .array(
        z.strictObject({
          field: text,
          values: z
            .array(z.union([text, z.number().finite(), z.null()]))
            .min(1)
            .max(100),
        }),
      )
      .max(8)
      .default([]),
  }),
  z.strictObject({
    op: z.literal("excel_chart"),
    sheet,
    name: text,
    anchor: z.strictObject({
      column: z.number().int().min(1).max(16370),
      row: z.number().int().min(1).max(1048540),
      widthColumns: z.number().int().min(1).max(100).default(10),
      heightRows: z.number().int().min(1).max(100).default(18),
    }),
    chart: z.strictObject({
      kind: z.enum(["column", "bar", "line", "pie", "doughnut", "area", "scatter", "combo"]),
      title: text.optional(),
      categoryAxisTitle: text.optional(),
      valueAxisTitle: text.optional(),
      legend: z.enum(["none", "right", "bottom", "top", "left"]).default("bottom"),
      series: z.array(series).min(1).max(32),
    }),
  }),
]);
export type ExcelOperation = z.infer<typeof ExcelOperationSchema>;
export type ExcelStyle = z.infer<typeof ExcelStyleSchema>;
