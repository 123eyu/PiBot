import { z } from "zod";

const text = z.string().max(2_000);
const index = z.number().int().nonnegative();
const number = z.number().finite();
const position = z.strictObject({
  x: number.optional(),
  y: number.optional(),
  width: number.optional(),
  height: number.optional(),
});
const part = z.string().max(512);
const item = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject({ ...shape, truncated: z.boolean().optional() });
export const OfficeStructureItemSchema = z.discriminatedUnion("kind", [
  item({
    kind: z.literal("heading"),
    paragraph: index.min(1),
    level: index.min(1).max(9),
    text,
  }),
  item({
    kind: z.literal("bookmark"),
    name: text,
    id: text.optional(),
    paragraph: index.optional(),
  }),
  item({ kind: z.literal("word_table"), rows: index, columns: index }),
  item({
    kind: z.literal("image"),
    ownerPart: part,
    part: part.optional(),
    description: text.optional(),
  }),
  item({
    kind: z.literal("section"),
    section: index,
    references: z
      .array(z.strictObject({ kind: z.enum(["header", "footer"]), type: text, part }))
      .max(6),
  }),
  item({
    kind: z.literal("header_footer"),
    type: z.enum(["header", "footer"]),
    part,
    text,
  }),
  item({ kind: z.literal("sheet"), sheet: index, name: text }),
  item({
    kind: z.literal("excel_table"),
    sheet: index,
    name: text,
    range: text.optional(),
    part,
  }),
  item({
    kind: z.literal("defined_name"),
    name: text,
    reference: text,
    localSheet: index.optional(),
  }),
  item({
    kind: z.literal("formula"),
    sheet: index,
    address: text,
    formula: text.optional(),
    formulaType: text.optional(),
    sharedIndex: text.optional(),
    range: text.optional(),
    references: z.array(text).max(32),
    coverage: z.enum(["static_a1_only", "partial", "shared_follower"]),
  }),
  item({
    kind: z.literal("pivot_table"),
    sheet: index,
    name: text,
    part,
    range: text.optional(),
    cacheId: text.optional(),
  }),
  item({
    kind: z.literal("validation"),
    sheet: index,
    range: text,
    type: text.optional(),
    formula1: text.optional(),
    formula2: text.optional(),
  }),
  item({ kind: z.literal("chart"), sheet: index, part, types: z.array(text).max(16) }),
  item({ kind: z.literal("master"), part, name: text.optional() }),
  item({
    kind: z.literal("layout"),
    part,
    name: text.optional(),
    masterPart: part.optional(),
    type: text.optional(),
  }),
  item({
    kind: z.literal("slide"),
    slide: index,
    part,
    layoutPart: part.optional(),
    title: text.optional(),
  }),
  item({
    kind: z.literal("shape"),
    slide: index,
    id: text.optional(),
    type: text,
    placeholder: z.strictObject({ type: text, index: text.optional() }).optional(),
    text: text.optional(),
    position,
    z: index,
    parentId: text.optional(),
  }),
  item({
    kind: z.literal("smartart"),
    slide: index,
    id: text.optional(),
    nodes: z.array(z.strictObject({ id: text.optional(), text })).max(20),
    links: z.array(z.tuple([text, text])).max(40),
  }),
  item({ kind: z.literal("notes"), slide: index, text }),
  item({
    kind: z.literal("problem"),
    part,
    code: z.enum(["invalid_relationship", "missing_part", "missing_cell_address"]),
    sheet: index.optional(),
    slide: index.optional(),
  }),
]);
export type OfficeStructureItem = z.infer<typeof OfficeStructureItemSchema>;
export const OfficeStructureKindSchema = z.enum([
  "heading",
  "bookmark",
  "word_table",
  "image",
  "section",
  "header_footer",
  "sheet",
  "excel_table",
  "defined_name",
  "formula",
  "pivot_table",
  "validation",
  "chart",
  "master",
  "layout",
  "slide",
  "shape",
  "smartart",
  "notes",
  "problem",
] satisfies OfficeStructureItem["kind"][]);
export const OfficeStructureQuerySchema = z.strictObject({
  collection: OfficeStructureKindSchema.optional(),
  offset: index.optional(),
  limit: index.min(1).max(200).optional(),
  sheet: index.optional(),
  slide: index.min(1).optional(),
});
export type OfficeStructureQuery = z.infer<typeof OfficeStructureQuerySchema>;
export const OfficeStructurePageSchema = z.strictObject({
  summary: z.strictObject({
    fields: z.boolean().optional(),
    formulas: z.boolean().optional(),
    comments: index.optional(),
    revisions: index.optional(),
    revisionKinds: z.record(z.string().max(100), index).optional(),
    sheets: index.optional(),
    slides: index.optional(),
    macros: z.boolean(),
    externalLinks: z.boolean(),
  }),
  items: z.array(OfficeStructureItemSchema).max(20),
  total: index,
  offset: index,
  nextOffset: index.nullable(),
  truncated: z.boolean(),
  coverage: z.string().max(500),
  warnings: z.array(z.string().max(100)).max(10),
  editSupport: z.string().max(200),
});
export type OfficeStructurePage = z.infer<typeof OfficeStructurePageSchema>;
