import { z } from "zod";

const text = z.string().max(10_000);
const name = z.string().min(1).max(100);
const ordinal = z.number().int().min(1).max(200_000);
const color = z.string().regex(/^[0-9a-fA-F]{6}$/u);
export const WordLocatorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("word_paragraph"), paragraph: ordinal }),
  z.strictObject({ kind: z.literal("word_bookmark"), name }),
  z.strictObject({ kind: z.literal("word_heading"), path: z.array(name).min(1).max(9) }),
  z.strictObject({ kind: z.literal("word_content_control"), tag: name }),
]);
export const WordRunFormatSchema = z.strictObject({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  script: z.enum(["baseline", "superscript", "subscript"]).optional(),
  color: color.optional(),
  highlight: z
    .enum([
      "yellow",
      "green",
      "cyan",
      "magenta",
      "blue",
      "red",
      "darkBlue",
      "darkCyan",
      "darkGreen",
      "darkMagenta",
      "darkRed",
      "darkYellow",
      "darkGray",
      "lightGray",
      "black",
      "white",
      "none",
    ])
    .optional(),
  font: z.string().min(1).max(100).optional(),
  size: z.number().int().min(2).max(400).optional(),
});
const page = z.strictObject({
  width: z.number().int().min(1440).max(31680).optional(),
  height: z.number().int().min(1440).max(31680).optional(),
  orientation: z.enum(["portrait", "landscape"]).optional(),
  margin: z
    .strictObject({
      top: z.number().int().min(0).max(14400),
      bottom: z.number().int().min(0).max(14400),
      left: z.number().int().min(0).max(14400),
      right: z.number().int().min(0).max(14400),
    })
    .optional(),
  type: z.enum(["continuous", "nextPage", "evenPage", "oddPage"]).optional(),
});
const image = z.strictObject({
  path: z.string().min(1).max(4096),
  width: z.number().int().min(1).max(1200),
  height: z.number().int().min(1).max(1200),
  alt: text,
  caption: text.optional(),
});
export const WordOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("word_format"),
    locator: WordLocatorSchema,
    format: WordRunFormatSchema,
    link: z
      .string()
      .max(2048)
      .regex(/^(?:https?:\/\/|mailto:|#)[^\s\p{Cc}]+$/u)
      .optional(),
  }),
  z.strictObject({
    op: z.literal("word_paragraph"),
    locator: WordLocatorSchema,
    style: name.optional(),
    align: z.enum(["left", "center", "right", "both"]).optional(),
    list: z
      .strictObject({ key: name, level: z.number().int().min(0).max(8), ordered: z.boolean() })
      .optional(),
  }),
  z.strictObject({
    op: z.literal("word_toc"),
    locator: WordLocatorSchema,
    levels: z.number().int().min(1).max(9).default(3),
  }),
  z.strictObject({
    op: z.literal("word_header_footer"),
    position: z.enum(["header", "footer"]),
    variant: z.enum(["default", "first", "even"]).default("default"),
    section: ordinal.default(1),
    text,
    pageNumber: z.boolean().default(false),
  }),
  z.strictObject({ op: z.literal("word_section"), locator: WordLocatorSchema.optional(), page }),
  z.strictObject({
    op: z.literal("word_style"),
    id: name,
    name,
    basedOn: name.optional(),
    next: name.optional(),
    outlineLevel: z.number().int().min(0).max(8).optional(),
    format: WordRunFormatSchema,
  }),
  z.strictObject({
    op: z.literal("word_table"),
    table: ordinal,
    repeatHeader: z.boolean().optional(),
    widths: z.array(z.number().int().min(1).max(31680)).min(1).max(50).optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    style: name.optional(),
    cellAlign: z.enum(["left", "center", "right", "both"]).optional(),
    verticalAlign: z.enum(["top", "center", "bottom"]).optional(),
    merges: z
      .array(
        z.strictObject({
          row: ordinal,
          column: ordinal,
          rows: z.number().int().min(1).max(1000),
          columns: z.number().int().min(1).max(50),
        }),
      )
      .max(100)
      .optional(),
  }),
  z.strictObject({ op: z.literal("word_image"), locator: WordLocatorSchema, image }),
  z.strictObject({ op: z.literal("word_footnote"), locator: WordLocatorSchema, text }),
  z.strictObject({
    op: z.literal("word_replace"),
    locator: WordLocatorSchema,
    oldText: z.string().min(1).max(10_000),
    newText: text,
    track: z.boolean().default(false),
  }),
  z.strictObject({
    op: z.literal("word_revision"),
    action: z.enum(["accept", "reject"]),
    ids: z.array(z.string().regex(/^\d+$/u)).min(1).max(100),
  }),
  z.strictObject({
    op: z.literal("word_comment"),
    action: z.enum(["add", "reply", "resolve"]),
    locator: WordLocatorSchema.optional(),
    id: z.string().regex(/^\d+$/u).optional(),
    text: text.optional(),
  }),
  z.strictObject({
    op: z.literal("word_bookmark"),
    action: z.enum(["add", "replace"]),
    locator: WordLocatorSchema.optional(),
    name: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
    text: text.optional(),
    track: z.boolean().default(false),
  }),
]);
export const WordOptionsSchema = z.strictObject({
  operations: z.array(WordOperationSchema).min(1).max(100),
});
export type WordOperation = z.infer<typeof WordOperationSchema>;
export type WordRunFormat = z.infer<typeof WordRunFormatSchema>;

export const WordReviewKindSchema = z.enum(["revisions", "comments", "bookmarks"]);
export const WordReviewPageSchema = z.strictObject({
  kind: WordReviewKindSchema,
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  entries: z
    .array(
      z.strictObject({
        id: z.string().max(100),
        type: z.string().max(40),
        text: z.string().max(1200),
        truncated: z.boolean(),
        name: z.string().max(100).optional(),
        author: z.string().max(200).optional(),
        date: z.string().max(100).optional(),
        parent: z.string().max(100).optional(),
        resolved: z.boolean().optional(),
      }),
    )
    .max(20),
});
export type WordReviewPage = z.infer<typeof WordReviewPageSchema>;
