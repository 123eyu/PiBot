import { z } from "zod";
import { BotCategorySchema, ImageModeSchema } from "../chat/media.ts";
import { IdSchema } from "../core/ids.ts";
import { CategorySchema, type PermissionOverridesSchema } from "../permissions/settings.ts";

/**
 * Built-in roles, group templates and professions (spec builtin-roles-and-group-templates.md
 * section 10). The `*File` schemas describe the read-only JSON shipped in `packages/teams/builtin`;
 * they strip unknown keys so a content file with an extra note field still loads. The `*View`
 * schemas are what brain sends to the window, already in the UI language.
 */
export const BuiltinIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !v.includes("\0"));
/** One text field in both languages (section 10 calls it L). */
export const localized = (max: number) => z.object({ zh: line(max), en: line(max) });
export type Localized = { zh: string; en: string };

export const BuiltinRoleCategorySchema = z.enum([
  "engineering",
  "product-design",
  "data-research",
  "content",
  "office",
  "general",
]);
/** Other categories still only tighten; the shipped command exception is checked below. */
export const TightLevelSchema = z.enum(["ask", "never"]);
export const BuiltinOverridesSchema = z
  .partialRecord(CategorySchema, z.enum(["ask", "never", "always"]))
  .refine((levels) =>
    Object.entries(levels).every(
      ([category, level]) => level !== "always" || category === "run_command",
    ),
  );
const uniqueIds = (max: number) =>
  z
    .array(BuiltinIdSchema)
    .max(max)
    .refine((v) => new Set(v).size === v.length, "Duplicate id");

export const BuiltinProfessionFileSchema = z.object({
  id: BuiltinIdSchema,
  name: localized(60),
  blurb: localized(200),
  icon: line(40),
  groups: uniqueIds(3).default([]),
  roles: uniqueIds(10).default([]),
  quickStart: localized(300).optional(),
});
export const BuiltinProfessionsFileSchema = z.array(BuiltinProfessionFileSchema).max(50);

export const BUILTIN_MAX_GROUPS = 3;
export const BUILTIN_MAX_BOTS = 10;

const text = (max: number) => z.string().max(max);
export const BuiltinSkillViewSchema = z.strictObject({
  id: BuiltinIdSchema,
  name: text(80),
  description: text(1024),
  /** Files besides SKILL.md, and how many of them are scripts or programs. */
  files: z.number().int().nonnegative().max(500),
  scripts: z.number().int().nonnegative().max(500),
});
/** Why a role cannot be created right now; shown next to the disabled choice. */
export const BuiltinUnavailableSchema = z.enum(["no_image_model"]);
export const BuiltinRoleViewSchema = z.strictObject({
  id: BuiltinIdSchema,
  version: z.number().int().min(1),
  category: BuiltinRoleCategorySchema,
  name: text(60),
  defaultBotName: text(60),
  summary: text(200),
  persona: text(4000),
  norms: text(8000),
  avatar: z.strictObject({ shape: text(40), color: text(40), eyes: text(40) }),
  botCategory: BotCategorySchema,
  imageMode: ImageModeSchema.optional(),
  permissionOverrides: BuiltinOverridesSchema,
  // Curated roles grew past five skills (presentation-designer has six); a too-small cap rejected
  // the whole catalog response and the role picker showed "cannot load" (maintainers 2026-11-11).
  skills: z.array(BuiltinSkillViewSchema).max(20),
  quickPrompts: z.array(text(300)).max(3),
  /**
   * Both languages, so a Bot made from this role can show its unedited suggestions in the current
   * interface language instead of the language it was created in (maintainers 2026-11-13).
   */
  quickPromptsByLanguage: z
    .strictObject({ zh: z.array(text(300)).max(3), en: z.array(text(300)).max(3) })
    .optional(),
  needs: z.strictObject({ vision: z.boolean(), imageGeneration: z.boolean() }),
  autoCheck: z.boolean(),
  unavailable: BuiltinUnavailableSchema.optional(),
  /** The default model cannot see images although the role works with them (hint only). */
  visionWarning: z.boolean().optional(),
});
export const BuiltinGroupViewSchema = z.strictObject({
  id: BuiltinIdSchema,
  version: z.number().int().min(1),
  name: text(200),
  summary: text(200),
  coordinator: BuiltinIdSchema,
  members: z.array(BuiltinIdSchema).min(2).max(6),
  announcement: text(8000),
  welcome: text(4000),
  quickStarts: z.array(text(300)).max(6),
  autoRoundLimit: z.number().int().min(1).max(10),
});
export const BuiltinProfessionViewSchema = z.strictObject({
  id: BuiltinIdSchema,
  name: text(60),
  blurb: text(200),
  icon: text(40),
  groups: z.array(BuiltinIdSchema).max(3),
  roles: z.array(BuiltinIdSchema).max(10),
  quickStart: text(300).optional(),
});
export const BuiltinCatalogSchema = z.strictObject({
  language: z.enum(["zh", "en"]),
  roles: z.array(BuiltinRoleViewSchema).max(200),
  groups: z.array(BuiltinGroupViewSchema).max(100),
  professions: z.array(BuiltinProfessionViewSchema).max(50),
});

export const BuiltinPlanSelectionSchema = z.strictObject({
  groups: z.array(BuiltinIdSchema).max(10).default([]),
  roles: z.array(BuiltinIdSchema).max(20).default([]),
  /** Professions the selection came from; only used for the groups' first quick start. */
  professions: z.array(BuiltinIdSchema).max(3).default([]),
  /** Profession flow: reuse an active Bot that already has the role instead of a new one. */
  reuseExisting: z.boolean().default(false),
  /** Roles to create again even though a Bot with that role exists ("再建一个"). */
  duplicate: z.array(BuiltinIdSchema).max(20).default([]),
});
export const BuiltinPlanSchema = z.strictObject({
  groups: z
    .array(
      z.strictObject({
        templateId: BuiltinIdSchema,
        name: text(200),
        coordinator: BuiltinIdSchema,
        members: z.array(BuiltinIdSchema).max(6),
        /** Members left out (e.g. the image role without an image model). */
        skipped: z
          .array(z.strictObject({ roleId: BuiltinIdSchema, reason: BuiltinUnavailableSchema }))
          .max(6),
        announcement: text(8000),
        /** False when fewer than two members remain; the group is then not created. */
        available: z.boolean(),
      }),
    )
    .max(10),
  bots: z
    .array(
      z.strictObject({
        roleId: BuiltinIdSchema,
        name: text(60),
        /** Template ids of the planned groups this Bot joins. */
        groups: z.array(BuiltinIdSchema).max(10),
        standalone: z.boolean(),
        /** An existing Bot with this role that will be reused instead of creating one. */
        existingBotId: IdSchema.optional(),
        existingBotName: text(200).optional(),
        unavailable: BuiltinUnavailableSchema.optional(),
      }),
    )
    .max(40),
  counts: z.strictObject({
    groups: z.number().int().nonnegative(),
    newBots: z.number().int().nonnegative(),
    maxGroups: z.number().int().positive(),
    maxBots: z.number().int().positive(),
  }),
});
export const BuiltinCreatedSchema = z.strictObject({
  botIds: z.array(IdSchema).max(BUILTIN_MAX_BOTS),
  groupIds: z.array(IdSchema).max(BUILTIN_MAX_GROUPS),
  reusedBotIds: z.array(IdSchema).max(40),
  /** Skills that could not be copied; the Bots and groups are already committed. */
  skippedSkills: z
    .array(z.strictObject({ botId: IdSchema, name: text(200) }))
    .max(200)
    .optional(),
});

/** Permission categories a role/template/import may tighten; the network override never travels. */
export function tightenOverrides(
  global: Record<z.infer<typeof CategorySchema>, "never" | "ask" | "always">,
  supplied: Partial<Record<z.infer<typeof CategorySchema>, "never" | "ask" | "always">>,
): {
  overrides: z.infer<typeof PermissionOverridesSchema>;
  lowered: z.infer<typeof CategorySchema>[];
} {
  const rank = { never: 0, ask: 1, always: 2 } as const;
  const overrides: z.infer<typeof PermissionOverridesSchema> = {};
  const lowered: z.infer<typeof CategorySchema>[] = [];
  for (const category of CategorySchema.options) {
    const value = supplied[category];
    if (value === undefined) continue;
    const level = value === "always" ? "ask" : value;
    if (value === "always") lowered.push(category);
    // Only a level stricter than the current default is kept; anything else follows the default.
    if (rank[level] < rank[global[category]]) overrides[category] = level;
  }
  return { overrides, lowered };
}

export type BuiltinProfessionFile = z.output<typeof BuiltinProfessionFileSchema>;
export type BuiltinRoleView = z.infer<typeof BuiltinRoleViewSchema>;
export type BuiltinGroupView = z.infer<typeof BuiltinGroupViewSchema>;
export type BuiltinProfessionView = z.infer<typeof BuiltinProfessionViewSchema>;
export type BuiltinCatalog = z.infer<typeof BuiltinCatalogSchema>;
export type BuiltinPlan = z.infer<typeof BuiltinPlanSchema>;
export type BuiltinSelection = z.input<typeof BuiltinPlanSelectionSchema>;

const isLocalized = (value: unknown): value is Localized =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === 2 &&
  typeof (value as Localized).zh === "string" &&
  typeof (value as Localized).en === "string";
const BOT_TEXT = ["name", "description", "systemPrompt", "norms"] as const;
const GROUP_TEXT = ["name", "announcement", "summary", "welcome"] as const;
/**
 * A version-3 team.json may give any user-visible text as `{zh, en}` (built-ins always do;
 * user exports write plain strings). This picks one language at exactly those places, before the
 * result is checked against `TeamTemplateSchema`; anything else is left for the schema to reject.
 */
export function localizeTeamJson(value: unknown, language: "zh" | "en"): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const pick = (text: unknown) => (isLocalized(text) ? text[language] : text);
  const list = (items: unknown) => (Array.isArray(items) ? items.map(pick) : items);
  const team = value as { bots?: unknown; groups?: unknown };
  const map = (items: unknown, fields: readonly string[]) =>
    Array.isArray(items)
      ? items.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return item;
          const copy: Record<string, unknown> = { ...item };
          for (const field of fields) if (field in copy) copy[field] = pick(copy[field]);
          for (const field of ["quickPrompts", "quickStarts"])
            if (field in copy) copy[field] = list(copy[field]);
          const role = copy.role;
          if (role && typeof role === "object" && "name" in role)
            copy.role = { ...role, name: pick((role as { name: unknown }).name) };
          return copy;
        })
      : items;
  return { ...team, bots: map(team.bots, BOT_TEXT), groups: map(team.groups, GROUP_TEXT) };
}
