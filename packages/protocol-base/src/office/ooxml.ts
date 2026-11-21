import { z } from "zod";
import { ExcelOperationSchema } from "./excel.ts";
import { PptOperationSchema } from "./presentation-ops.ts";
import { WordOperationSchema } from "./word.ts";

export type { ExcelOperation, ExcelStyle } from "./excel.ts";
export { ExcelOperationSchema, ExcelStyleSchema } from "./excel.ts";
export type { PptOperation } from "./presentation-ops.ts";
export { PptOperationSchema } from "./presentation-ops.ts";

const name = z.string().min(1).max(255);
const ordinal = z.number().int().min(1).max(200_000);
export const OfficeLocatorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("word_paragraph"), paragraph: ordinal }),
  z.strictObject({ kind: z.literal("word_bookmark"), name }),
  z.strictObject({ kind: z.literal("word_heading"), path: z.array(name).min(1).max(9) }),
  z.strictObject({ kind: z.literal("word_content_control"), tag: name }),
  z.strictObject({
    kind: z.literal("excel_cell"),
    address: z
      .string()
      .max(39)
      .regex(/^.{1,31}![A-Z]{1,3}[1-9][0-9]{0,6}$/u),
  }),
  z.strictObject({ kind: z.literal("excel_table"), name }),
  z.strictObject({ kind: z.literal("excel_defined_name"), name }),
  z.strictObject({
    kind: z.literal("powerpoint_shape"),
    slide: ordinal,
    shapeId: z.number().int().min(1).max(0xffff_ffff),
  }),
  z.strictObject({ kind: z.literal("powerpoint_placeholder"), slide: ordinal, type: name }),
]);
export type OfficeLocator = z.infer<typeof OfficeLocatorSchema>;

export const OfficeTextOperationsSchema = z
  .array(
    z.union([
      WordOperationSchema,
      z.strictObject({
        op: z.literal("replace_text"),
        locator: OfficeLocatorSchema,
        oldText: z.string().min(1).max(10_000),
        newText: z.string().max(10_000),
      }),
    ]),
  )
  .min(1)
  .max(100);
export type OfficeTextOperation = z.infer<typeof OfficeTextOperationsSchema>[number];

export const OfficeOperationsSchema = z
  .array(z.union([OfficeTextOperationsSchema.element, ExcelOperationSchema, PptOperationSchema]))
  .min(1)
  .max(100);
export type OfficeOperation = z.infer<typeof OfficeOperationsSchema>[number];

export const OfficeValidationSchema = z.strictObject({
  serious: z.number().int().nonnegative(),
  notices: z.number().int().nonnegative(),
  issues: z
    .array(
      z.strictObject({
        severity: z.enum(["serious", "notice"]),
        code: z.enum([
          "invalid_archive",
          "invalid_xml",
          "invalid_schema",
          "invalid_content_types",
          "missing_content_type",
          "invalid_relationship",
          "duplicate_id",
          "missing_part",
          "missing_relationship",
          "external_relationship",
          "macro_present",
          "word_heading_jump",
          "word_empty_heading",
          "word_table_missing_header",
        ]),
      }),
    )
    .max(100),
});
export type OfficeValidation = z.infer<typeof OfficeValidationSchema>;

export {
  type WordOperation,
  WordReviewKindSchema,
  type WordReviewPage,
  WordReviewPageSchema,
} from "./word.ts";
