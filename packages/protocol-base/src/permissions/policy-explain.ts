import { z } from "zod";

export const PolicyStepSchema = z
  .strictObject({
    axis: z.enum([
      "category",
      "level",
      "boundary",
      "danger",
      "grant",
      "connector",
      "secret",
      "yolo",
      "intrinsic",
    ]),
    code: z.string().regex(/^[a-z0-9_]{1,64}$/),
    effect: z.enum(["allow", "ask", "deny", "narrow", "info"]),
    level: z.enum(["always", "ask", "never"]).optional(),
    source: z.enum(["default", "bot", "group", "routine"]).optional(),
  })
  .refine(
    (step) => step.axis === "level" || (step.level === undefined && step.source === undefined),
    "Level metadata belongs to the level axis",
  );

export type PolicyStep = z.infer<typeof PolicyStepSchema>;
