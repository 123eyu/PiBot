import { z } from "zod";
import { WordOptionsSchema } from "./word.ts";

export type {
  OfficeStructureItem,
  OfficeStructurePage,
  OfficeStructureQuery,
} from "./structure.ts";
export {
  OfficeStructureItemSchema,
  OfficeStructureKindSchema,
  OfficeStructurePageSchema,
  OfficeStructureQuerySchema,
} from "./structure.ts";

import {
  OfficePresentationTemplateSchema,
  OfficePresentationThemeSchema,
  officeSlidePresentationFields,
  type PresentationLayouts,
} from "./presentation.ts";

export * from "./presentation.ts";

const text = z.string().max(100_000);
const id = z.string().max(100);
export const OfficeFormatSchema = z.enum(["docx", "xlsx", "pptx"]);
export const OfficeBlockSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: id.optional(),
      type: z.literal("paragraph"),
      text,
      image: z
        .strictObject({
          path: z.string().min(1).max(4096),
          width: z.number().int().min(1).max(1200),
          height: z.number().int().min(1).max(1200),
        })
        .optional(),
    })
    .strict(),
  z
    .object({
      id: id.optional(),
      type: z.literal("heading"),
      text,
      level: z.number().int().min(1).max(6).default(1),
    })
    .strict(),
  z
    .object({
      id: id.optional(),
      type: z.literal("table"),
      rows: z.array(z.array(z.string().max(10_000)).max(50)).max(1_000),
    })
    .strict(),
]);
export const OfficeCellSchema = z.union([
  z.string().max(10_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z
    .object({
      formula: z.string().min(1).max(2_000),
      cachedValue: z.union([z.string().max(10_000), z.number().finite(), z.boolean()]).optional(),
    })
    .strict(),
]);
export const OfficeSheetSchema = z
  .object({
    name: z.string().min(1).max(31),
    rows: z.array(z.array(OfficeCellSchema).max(100)).max(5_000),
  })
  .strict();
export const OfficeSlideSchema = z
  .object({
    id: id.optional(),
    title: z.string().max(500).optional(),
    text: text.optional(),
    ...officeSlidePresentationFields,
  })
  .strict();
export const OfficeContentSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("docx"),
        title: z.string().max(500).optional(),
        blocks: z.array(OfficeBlockSchema).max(2_000),
        word: WordOptionsSchema.optional(),
      })
      .strict(),
    z
      .object({ kind: z.literal("xlsx"), sheets: z.array(OfficeSheetSchema).min(1).max(50) })
      .strict(),
    z
      .object({
        kind: z.literal("pptx"),
        title: z.string().max(500).optional(),
        slides: z.array(OfficeSlideSchema).min(1).max(200),
        theme: OfficePresentationThemeSchema.optional(),
        template: OfficePresentationTemplateSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((content, context) => {
    if (content.kind === "pptx") {
      const invalid =
        (content.theme !== undefined && content.template !== undefined) ||
        content.slides.some((slide) => slide.templateLayout !== undefined && !content.template);
      const objects = content.slides.flatMap((slide) => slide.objects ?? []);
      if (
        invalid ||
        objects.length > 240 ||
        objects.filter(({ type }) => type === "chart").length > 20
      )
        context.addIssue({ code: "custom", message: "office_content_limit" });
    }
    if (new TextEncoder().encode(JSON.stringify(content)).byteLength > 2 * 1024 * 1024)
      context.addIssue({ code: "custom", message: "office_content_limit" });
    if (
      content.kind === "xlsx" &&
      content.sheets.reduce(
        (total, sheet) => total + sheet.rows.reduce((count, row) => count + row.length, 0),
        0,
      ) > 100_000
    )
      context.addIssue({ code: "custom", message: "office_content_limit" });
  });
export type OfficeFormat = z.infer<typeof OfficeFormatSchema>;
export type OfficeContent = z.infer<typeof OfficeContentSchema>;
export type OfficeCell = z.infer<typeof OfficeCellSchema>;
export type OfficeDecoded = {
  format: OfficeFormat;
  content: OfficeContent;
  warnings: string[];
  presentationLayouts?: PresentationLayouts;
  features: { macros: boolean; externalLinks: boolean; encrypted: boolean; unsupported: boolean };
};
