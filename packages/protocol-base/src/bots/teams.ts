import { z } from "zod";
import { IdSchema } from "../core/ids.ts";
import { GroupVerificationRulesSchema } from "../groups/verification.ts";
import { BotPermissionOverridesSchema, CategorySchema } from "../permissions/settings.ts";
import { ModelPreferenceSchema, ThinkingLevelSchema } from "../providers/providers.ts";
import { SkillImportSourceSchema, TeamSkillSchema } from "../skills/skills.ts";
import { BotSchema } from "./bot.ts";

const label = z.string().trim().min(1).max(200);
const time = z.iso.datetime();
/** Folder name of one skill inside a version-3 file (the saved skill's slug or a built-in id). */
export const TeamSkillFolderSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
/**
 * Version 3 keeps each skill as a package folder `skills/<ref>/<folder>/` (SKILL.md plus
 * scripts and references; a built-in carries `zh/` and `en/` variants inside it). team.json only
 * names the folder; readers turn it into the inline form (with `folder`) for previews and import.
 */
export const TeamSkillRefSchema = z.strictObject({
  folder: TeamSkillFolderSchema,
  enabled: z.boolean(),
});
/** No executable content: the receiving user must explicitly preview and import the public source. */
export const TeamSkillReimportSchema = z.strictObject({
  folder: TeamSkillFolderSchema,
  enabled: z.literal(false),
  name: z.string().min(1).max(80),
  description: z.string().max(1024),
  reimport: z.strictObject({
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    source: SkillImportSourceSchema.optional(),
    reason: z.enum(["source_required", "local_too_large"]),
  }),
});
export type TeamSkillReimport = z.infer<typeof TeamSkillReimportSchema>;
const RoleIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const TeamBotSchema = z.strictObject({
  ref: label,
  name: label,
  category: BotSchema.shape.category,
  imageMode: BotSchema.shape.imageMode,
  description: z.string().max(4000),
  systemPrompt: z.string().max(100000),
  avatarShape: label,
  avatarColor: label,
  avatarEyes: label,
  avatarImage: BotSchema.shape.avatarImage,
  model: ModelPreferenceSchema.nullable(),
  thinkingLevel: ThinkingLevelSchema.default("medium"),
  thinkingPreference: ThinkingLevelSchema.nullable().optional(),
  permissionOverrides: BotPermissionOverridesSchema,
  // Version 2: the Bot's skills travel with it inline; version 1 files never carry them.
  skills: z
    .array(
      z.union([
        TeamSkillSchema.extend({ folder: TeamSkillFolderSchema.optional() }),
        TeamSkillRefSchema,
        TeamSkillReimportSchema,
      ]),
    )
    .max(100)
    .refine(
      (v) =>
        new Set(v.map((s) => ("name" in s ? s.name : s.folder).toLowerCase())).size === v.length,
      "Duplicate skill",
    )
    .refine(
      (v) =>
        new Set(v.flatMap((s) => (s.folder ? [s.folder] : []))).size ===
        v.filter((s) => s.folder).length,
      "Duplicate skill folder",
    )
    .optional(),
  // Version 3: which built-in role the Bot came from. A mark only: nothing in it is trusted
  // on import; `name` / `category` describe the role in the built-in role picker.
  role: z
    .strictObject({
      id: RoleIdSchema,
      version: z.number().int().min(1).max(100000),
      name: z.string().trim().min(1).max(60).optional(),
      category: z
        .enum(["engineering", "product-design", "data-research", "content", "office", "general"])
        .optional(),
    })
    .optional(),
  norms: z.string().max(20000).optional(),
  quickPrompts: z.array(z.string().trim().min(1).max(300)).max(3).optional(),
  /** The role's default for the automatic check before a dev Bot says it is done. */
  autoCheck: z.boolean().optional(),
  needs: z.strictObject({ vision: z.boolean(), imageGeneration: z.boolean() }).optional(),
});
export const TeamGroupSchema = z.strictObject({
  verification: GroupVerificationRulesSchema.optional(),
  name: label,
  members: z
    .array(label)
    .min(2)
    .max(6)
    .refine((v) => new Set(v).size === v.length),
  coordinator: label,
  announcement: z.string().max(8000),
  autoRoundLimit: z.number().int().min(1).max(10),
  // Version 3: built-in group templates; `welcome` is the coordinator's fixed first message.
  template: z
    .strictObject({ id: RoleIdSchema, version: z.number().int().min(1).max(100000) })
    .optional(),
  summary: z.string().trim().min(1).max(200).optional(),
  welcome: z.string().max(4000).optional(),
  quickStarts: z.array(z.string().trim().min(1).max(300)).max(6).optional(),
});
/** Version 1/2 files are plain JSON ≤ 1 MB; version 3 is a zip whose team.json may be larger. */
export const TEAM_JSON_MAX_BYTES = 1048576;
export const TEAM_V3_JSON_MAX_BYTES = 4 * 1048576;
/** The whole version-3 `.pibot` archive, compressed and uncompressed (spec section 5). */
export const TEAM_ARCHIVE_MAX_BYTES = 20 * 1048576;
export const TEAM_ARCHIVE_MAX_FILES = 2000;
export const TeamTemplateSchema = z
  .strictObject({
    format: z.literal("pibot-team"),
    // Readers accept all three; version 2 adds per-Bot skills, version 3 (a zip, or the same
    // content unpacked into a `<id>.pibot/` folder) adds skill packages, roles, norms, starters.
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    bots: z.array(TeamBotSchema).min(1).max(100),
    groups: z.array(TeamGroupSchema).max(100),
  })
  .superRefine((v, ctx) => {
    if (v.version === 1 && v.bots.some((b) => b.skills !== undefined))
      ctx.addIssue({ code: "custom", message: "Skills require team file version 2" });
    if (
      v.version !== 3 &&
      (v.bots.some(
        (b) =>
          b.role !== undefined ||
          b.norms !== undefined ||
          b.quickPrompts !== undefined ||
          b.autoCheck !== undefined ||
          b.needs !== undefined ||
          b.skills?.some((s) => s.folder !== undefined),
      ) ||
        v.groups.some(
          (g) =>
            g.template !== undefined ||
            g.summary !== undefined ||
            g.welcome !== undefined ||
            g.quickStarts !== undefined,
        ))
    )
      ctx.addIssue({ code: "custom", message: "Roles, norms and skill packages need version 3" });
    if (
      v.bots.some((b) =>
        b.category === "image"
          ? // A version-3 image Bot may leave the model open; import then picks an image model.
            !b.imageMode || (!b.model && v.version !== 3)
          : b.imageMode !== undefined,
      ) ||
      v.groups.some((g) => v.bots.find((b) => b.ref === g.coordinator)?.category === "image")
    )
      ctx.addIssue({ code: "custom", message: "Invalid image Bot or coordinator" });
    const refs = new Set(v.bots.map((b) => b.ref));
    if (
      refs.size !== v.bots.length ||
      v.groups.some(
        (g) => !g.members.includes(g.coordinator) || g.members.some((b) => !refs.has(b)),
      )
    )
      ctx.addIssue({ code: "custom", message: "Invalid team references" });
    if (
      new TextEncoder().encode(JSON.stringify(v)).byteLength >
      (v.version === 3 ? TEAM_V3_JSON_MAX_BYTES : TEAM_JSON_MAX_BYTES)
    )
      ctx.addIssue({ code: "custom", message: "Team exceeds its size limit" });
  });
/** One supporting file of a version-3 import, listed in the preview before anything is created. */
export const TeamPreviewFileSchema = z.strictObject({
  ref: label,
  skill: z.string().min(1).max(80),
  path: z.string().min(1).max(512),
  bytes: z.number().int().nonnegative(),
  script: z.boolean(),
  text: z.boolean(),
});
export const TeamPreviewSchema = z.strictObject({
  previewId: IdSchema,
  template: TeamTemplateSchema,
  models: z.array(
    z.strictObject({
      ref: label,
      preferred: ModelPreferenceSchema.nullable(),
      resolved: ModelPreferenceSchema.nullable(),
      available: z.boolean(),
      thinkingLevel: ThinkingLevelSchema,
    }),
  ),
  expiresAt: time,
  /** Version 3: supporting files of the skills (each SKILL.md text is in the template itself). */
  files: z.array(TeamPreviewFileSchema).max(TEAM_ARCHIVE_MAX_FILES).optional(),
  /** Archive entries that belong to no Bot skill; they are not imported. */
  skippedFiles: z.number().int().nonnegative().max(100000).optional(),
  /** Whether the imported archive matched a locally cached signed catalog entry. */
  provenance: z
    .strictObject({
      status: z.enum(["official", "unverified"]),
      reason: z.enum(["catalog_match", "no_catalog_match"]),
    })
    .optional(),
  /**
   * What the file asked for but will not apply — "always" lowered to "ask" (`lowered`),
   * levels not stricter than the local default (`relaxed`, they follow it) and any network scope.
   */
  permissionNotes: z
    .array(
      z.strictObject({
        ref: label,
        lowered: z.array(CategorySchema).max(9),
        relaxed: z.array(CategorySchema).max(9),
        network: z.boolean(),
      }),
    )
    .max(100)
    .optional(),
});
export type TeamTemplate = z.infer<typeof TeamTemplateSchema>;
export type TeamPreview = z.infer<typeof TeamPreviewSchema>;
