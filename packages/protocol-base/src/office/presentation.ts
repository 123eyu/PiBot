import { z } from "zod";

export const OfficePresentationThemeSchema = z.enum([
  "classic",
  "midnight",
  "editorial",
  "forest",
  "studio",
  "minimal",
]);
export const OfficePresentationLayoutSchema = z.enum([
  "cover",
  "agenda",
  "section",
  "title-body",
  "two-column",
  "image-text",
  "full-image",
  "chart",
  "table",
  "quote",
  "closing",
]);

const shortText = z.string().max(500);
const color = z.string().regex(/^[0-9a-fA-F]{6}$/);
const ordinal = z.number().int().min(1).max(64);
const url = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((value) => {
    if (!/^https?:\/\//iu.test(value) || /[\p{Cc}\s\\]/u.test(value)) return false;
    const parsed = new URL(value);
    return !!parsed.hostname && !parsed.username && !parsed.password;
  });
const box = z
  .strictObject({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0.01).max(1),
    height: z.number().min(0.01).max(1),
  })
  .refine(({ x, y, width, height }) => x + width <= 1 && y + height <= 1);

const chartType = z.enum(["column", "bar", "line", "pie", "doughnut", "area", "scatter", "combo"]);
const chartValue = z.number().finite().min(-1e100).max(1e100);
const chartSeries = z.strictObject({
  name: shortText.min(1),
  values: z.array(chartValue).min(1).max(100),
  color: color.optional(),
  kind: z.enum(["column", "line", "area"]).optional(),
});
const tableRows = z
  .array(z.array(shortText).min(1).max(12))
  .min(1)
  .max(30)
  .refine((rows) => rows.every((row) => row.length === rows[0]?.length));

export const OfficePresentationObjectSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("image"),
    box: box.optional(),
    path: z.string().min(1).max(4096),
    fit: z.enum(["contain", "cover"]).optional(),
    alt: shortText.optional(),
    link: url.optional(),
  }),
  z.strictObject({ type: z.literal("table"), box: box.optional(), rows: tableRows }),
  z
    .strictObject({
      type: z.literal("chart"),
      box: box.optional(),
      kind: chartType,
      title: shortText.optional(),
      categories: z
        .array(z.union([shortText, chartValue]))
        .min(1)
        .max(100),
      series: z.array(chartSeries).min(1).max(8),
      xAxisTitle: shortText.optional(),
      yAxisTitle: shortText.optional(),
      legend: z.boolean().optional(),
    })
    .refine(
      ({ kind, categories, series }) =>
        series.every(
          (item) =>
            item.values.length === categories.length &&
            (item.kind !== undefined) === (kind === "combo"),
        ) &&
        (kind !== "scatter" || categories.every((value) => typeof value === "number")) &&
        ((kind !== "pie" && kind !== "doughnut") ||
          (series.length === 1 &&
            series.every(
              ({ values }) =>
                values.every((value) => value >= 0) && values.some((value) => value > 0),
            ))),
    ),
  z.strictObject({
    type: z.literal("shape"),
    box: box.optional(),
    shape: z.enum(["rect", "roundRect", "ellipse", "line", "chevron", "rightArrow", "triangle"]),
    text: shortText.optional(),
    color: color.optional(),
    link: url.optional(),
  }),
  z.strictObject({
    type: z.literal("icon"),
    box: box.optional(),
    icon: z.enum(["check", "arrow", "chart", "target", "document", "spark"]),
    color: color.optional(),
    link: url.optional(),
  }),
  z.strictObject({
    type: z.literal("text"),
    box: box.optional(),
    text: shortText.min(1),
    link: url.optional(),
  }),
  z.strictObject({
    type: z.literal("smartart"),
    box: box.optional(),
    kind: z.enum(["flow", "cycle", "hierarchy", "list", "matrix", "timeline"]),
    items: z.array(shortText.min(1)).min(2).max(8),
    color: color.optional(),
  }),
]);

export const OfficePresentationTemplateSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  expectedRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  master: z.number().int().min(1).max(8).optional(),
});
export const OfficePresentationLayoutsSchema = z
  .array(
    z.strictObject({
      master: ordinal,
      layoutCount: ordinal,
      layouts: z
        .array(
          z.strictObject({
            layout: ordinal,
            name: shortText,
            type: shortText,
            placeholders: z
              .array(z.strictObject({ type: shortText, index: z.string().max(20).optional() }))
              .max(64),
          }),
        )
        .max(64),
    }),
  )
  .max(8);

export const officeSlidePresentationFields = {
  layout: OfficePresentationLayoutSchema.optional(),
  templateLayout: ordinal.optional(),
  subtitle: shortText.optional(),
  secondaryText: z.string().max(20_000).optional(),
  notes: z.string().max(10_000).optional(),
  objects: z.array(OfficePresentationObjectSchema).max(20).optional(),
};

export type PresentationThemeId = z.infer<typeof OfficePresentationThemeSchema>;
export type PresentationLayoutId = z.infer<typeof OfficePresentationLayoutSchema>;
export type PresentationObject = z.infer<typeof OfficePresentationObjectSchema>;
export type PresentationTemplate = z.infer<typeof OfficePresentationTemplateSchema>;
export type PresentationLayouts = z.infer<typeof OfficePresentationLayoutsSchema>;
