import {
  BotSchema,
  BuiltinCatalogSchema,
  BuiltinCreatedSchema,
  BuiltinIdSchema,
  BuiltinPlanSchema,
  BuiltinPlanSelectionSchema,
  CategorySchema,
  IdSchema,
} from "@pibot/protocol-base";
import { z } from "zod";

const label = z.string().max(200);
/** One Bot or one group, never both, plus the method's own fields. */
const target = <T extends z.ZodRawShape>(fields: T) =>
  z.union([
    z.strictObject({ botId: IdSchema, ...fields }),
    z.strictObject({ groupId: IdSchema, ...fields }),
  ]);
/**
 * One line of the「采用新版」preview. `changes` lists what adopting does; `kept` lists
 * what stays because the user changed it (or it cannot be recognised as unchanged). Names and
 * short values only, never norms, announcements or skill text.
 */
export const BuiltinChangeSchema = z.strictObject({
  item: z.enum([
    "norms",
    "skill",
    "permission",
    "thinking",
    "announcement",
    "coordinator",
    "roundLimit",
    "quickStarts",
    "member",
  ]),
  action: z.enum(["update", "add", "remove", "keep"]),
  name: label.optional(),
  category: CategorySchema.optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  /** Why a line is kept: changed by the user, removed by the user, no record, not in the new version. */
  reason: z.enum(["changed", "removed", "unknown", "dropped"]).optional(),
});
export const BuiltinUpdatePreviewSchema = z.strictObject({
  kind: z.enum(["bot", "group"]),
  /**
   * Available means a newer built-in version is still to be applied (the automatic pass
   * could not finish); current means the newest one is in place and, when `restorable`, the values
   * it replaced are kept for「恢复上一版」.
   */
  state: z.enum(["available", "current"]),
  /** A recovery record exists: the version this one replaced can be put back. */
  restorable: z.boolean(),
  sourceId: BuiltinIdSchema,
  /** Role or template name in the UI language. */
  name: label,
  /** 0: a group recognised as made from the template, version unknown. */
  fromVersion: z.number().int().min(0),
  toVersion: z.number().int().min(1),
  /** The user answered「保留当前」for this version. */
  dismissed: z.boolean(),
  /**
   * recorded: values stored when it was made / last updated; history: matched against the
   * released versions shipped with the app; none: nothing to compare, everything is kept.
   */
  provenance: z.enum(["recorded", "history", "none"]),
  /** Opaque token: `apply` refuses when anything in the preview changed meanwhile. */
  revision: z.string().regex(/^[a-f0-9]{16}$/),
  changes: z.array(BuiltinChangeSchema).max(100),
  kept: z.array(BuiltinChangeSchema).max(100),
  /** Group only: members of the new template the group lacks; added only when the user picks them. */
  members: z
    .array(
      z.strictObject({
        roleId: BuiltinIdSchema,
        name: label,
        existingBotName: label.optional(),
      }),
    )
    .max(6),
  /** Group only: the new template's quick starts (they live in the welcome message, not settings). */
  quickStarts: z.array(z.string().max(300)).max(6),
});
export type BuiltinChange = z.infer<typeof BuiltinChangeSchema>;
export type BuiltinUpdatePreview = z.infer<typeof BuiltinUpdatePreviewSchema>;

export const BuiltinMethods = {
  "builtin.catalog": {
    params: z.union([z.undefined(), z.strictObject({})]),
    result: BuiltinCatalogSchema,
  },
  "builtin.plan": { params: BuiltinPlanSelectionSchema, result: BuiltinPlanSchema },
  "builtin.create": {
    params: BuiltinPlanSelectionSchema.extend({ source: z.enum(["template", "profession"]) }),
    result: BuiltinCreatedSchema,
  },
  /** New Bot from one role; `name` defaults to the role's Bot name. */
  "builtin.createBot": {
    params: z.strictObject({
      roleId: BuiltinIdSchema,
      name: z.string().trim().min(1).max(200).optional(),
      description: z.string().trim().max(4000).optional(),
    }),
    result: z.strictObject({
      bot: BotSchema,
      skippedSkills: BuiltinCreatedSchema.shape.skippedSkills,
    }),
  },
  /** Null when the Bot / group is not behind a built-in version (or not from one). */
  "builtin.update.preview": {
    params: target({}),
    result: BuiltinUpdatePreviewSchema.nullable(),
  },
  "builtin.update.apply": {
    params: target({
      toVersion: z.number().int().min(1),
      revision: z.string().regex(/^[a-f0-9]{16}$/),
      /** Group only: new template members the user chose to add. */
      addMembers: z.array(BuiltinIdSchema).max(6).optional(),
    }),
    result: z.strictObject({
      ok: z.literal(true),
      /** Steps that failed after others were saved; the next preview shows what is left. */
      failed: z.array(BuiltinChangeSchema).max(100),
    }),
  },
  "builtin.update.dismiss": {
    params: target({ version: z.number().int().min(1) }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
  /**
   * Puts back what the last automatic update replaced, and remembers the version it came
   * from as declined so the next start does not apply it again.
   */
  "builtin.update.restore": {
    params: target({}),
    result: z.strictObject({
      ok: z.literal(true),
      failed: z.array(BuiltinChangeSchema).max(100),
    }),
  },
} as const;
