import { z } from "zod";
import { OfficeSlideSchema } from "./content.ts";

const slideIndex = z.number().int().min(1).max(200);
const shapeId = z.number().int().min(1).max(0xffff_ffff);
const fraction = z.number().finite().min(0).max(1);
const extent = z.number().finite().min(0.01).max(1);
const uniqueIds = z
  .array(shapeId)
  .min(1)
  .max(64)
  .refine((ids) => new Set(ids).size === ids.length);

/** Normalized slide fractions; only supplied edges are changed so move and resize stay separable. */
const transform = z
  .strictObject({
    op: z.literal("ppt_transform"),
    slide: slideIndex,
    shapeId,
    x: fraction.optional(),
    y: fraction.optional(),
    width: extent.optional(),
    height: extent.optional(),
  })
  .refine(
    (value) =>
      value.x !== undefined ||
      value.y !== undefined ||
      value.width !== undefined ||
      value.height !== undefined,
  )
  .refine(
    (value) => value.x === undefined || value.width === undefined || value.x + value.width <= 1,
  )
  .refine(
    (value) => value.y === undefined || value.height === undefined || value.y + value.height <= 1,
  );

export const PptOperationSchema = z.union([
  transform,
  z.strictObject({ op: z.literal("ppt_delete"), slide: slideIndex, shapeId }),
  z.strictObject({
    op: z.literal("ppt_duplicate"),
    slide: slideIndex,
    shapeId,
    x: fraction.optional(),
    y: fraction.optional(),
  }),
  z.strictObject({
    op: z.literal("ppt_align"),
    slide: slideIndex,
    shapeIds: uniqueIds.min(2),
    align: z.enum(["left", "center", "right", "top", "middle", "bottom"]),
  }),
  z.strictObject({
    op: z.literal("ppt_distribute"),
    slide: slideIndex,
    shapeIds: uniqueIds.min(3),
    axis: z.enum(["horizontal", "vertical"]),
  }),
  z.strictObject({
    op: z.literal("ppt_size"),
    slide: slideIndex,
    shapeIds: uniqueIds.min(2),
    dimension: z.enum(["width", "height", "both"]),
  }),
  z.strictObject({
    op: z.literal("ppt_z_order"),
    slide: slideIndex,
    shapeId,
    direction: z.enum(["front", "back", "forward", "backward"]),
  }),
  z.strictObject({
    op: z.literal("ppt_group"),
    slide: slideIndex,
    shapeIds: uniqueIds.min(2),
  }),
  z.strictObject({ op: z.literal("ppt_ungroup"), slide: slideIndex, shapeId }),
  z.strictObject({
    op: z.literal("ppt_snap"),
    slide: slideIndex,
    shapeIds: uniqueIds,
    grid: z.number().finite().min(0.005).max(0.2),
  }),
  z.strictObject({
    op: z.literal("ppt_slide_add"),
    after: slideIndex.optional(),
    // Reuses the create content model so a new page can carry native charts and SmartArt.
    content: OfficeSlideSchema.optional(),
  }),
  z.strictObject({ op: z.literal("ppt_slide_duplicate"), slide: slideIndex }),
  z.strictObject({ op: z.literal("ppt_slide_delete"), slide: slideIndex }),
  z.strictObject({ op: z.literal("ppt_slide_move"), slide: slideIndex, to: slideIndex }),
]);

export type PptOperation = z.infer<typeof PptOperationSchema>;
