import {
  IdSchema,
  SKILL_IMPORT_MAX_BYTES,
  SkillDescriptionSchema,
  SkillNameSchema,
} from "@pibot/protocol-base";
import { z } from "zod";
import { SkillImportDetailsSchema } from "./skills.ts";

export const SkillLinkResolutionSchema = z.strictObject({
  sourceId: IdSchema,
  host: z.string().max(253),
  owner: z.string().max(100).optional(),
  repo: z.string().max(100).optional(),
  ref: z.string().max(512).optional(),
  subpath: z.string().max(512),
  /** Confirmed Content-Length of the archive, when the source reported one. */
  bytes: z.number().int().nonnegative().max(SKILL_IMPORT_MAX_BYTES).nullable(),
  /**
   * Advisory total for the progress bar (GitHub repository size). It is deliberately separate from
   * `bytes`: the estimate covers compressed or uncompressed content differently, so it must never
   * be used to decide that the source changed between resolving and downloading.
   */
  estimateBytes: z.number().int().nonnegative().max(SKILL_IMPORT_MAX_BYTES).nullable(),
  expiresAt: z.iso.datetime(),
});
export const SkillLinkListingSchema = z.strictObject({
  sourceId: IdSchema,
  selectionId: IdSchema.optional(),
  skills: z
    .array(
      z.strictObject({
        id: IdSchema,
        name: SkillNameSchema,
        description: SkillDescriptionSchema,
        bytes: z.number().int().nonnegative().max(SKILL_IMPORT_MAX_BYTES),
        fileCount: z.number().int().min(1).max(20_000),
        runtimes: z.array(z.enum(["python", "node", "bash", "powershell"])).max(4),
        selected: z.boolean(),
      }),
    )
    .max(200),
  components: z.strictObject({
    mcp: z.boolean(),
    commands: z.boolean(),
    /** External marketplace entries require their own source/size confirmation, never auto-follow. */
    externalPlugins: z.number().int().nonnegative().max(200),
  }),
  externalSources: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(80),
        url: z.url().max(2048).nullable(),
        reason: z.enum(["confirmation_required", "unsupported"]),
      }),
    )
    .max(200),
  expiresAt: z.iso.datetime(),
});
export type SkillLinkResolution = z.output<typeof SkillLinkResolutionSchema>;
export type SkillLinkListing = z.output<typeof SkillLinkListingSchema>;
export const SkillLinkMethods = {
  "skills.resolveLink": {
    // Reading the link does a few HEAD/API requests. The brain renews its own deadline on progress
    // and stops on an idle connection, so this ceiling only bounds a call that never settles.
    timeoutMs: 15 * 60_000,
    params: z.strictObject({ url: z.string().trim().min(1).max(2048) }),
    result: SkillLinkResolutionSchema,
  },
  "skills.downloadLink": {
    timeoutMs: 125 * 60_000,
    params: z.strictObject({
      sourceId: IdSchema,
      confirmed: z.literal(true),
    }),
    result: SkillLinkListingSchema,
  },
  "skills.previewLink": {
    timeoutMs: 125 * 60_000,
    params: z.strictObject({
      sourceId: IdSchema,
      candidateId: IdSchema,
      botId: IdSchema,
      groupId: IdSchema.optional(),
    }),
    result: SkillImportDetailsSchema,
  },
  "skills.cancelLink": {
    timeoutMs: 125 * 60_000,
    params: z.strictObject({ sourceId: IdSchema }),
    result: z.strictObject({ ok: z.literal(true) }),
  },
} as const;

export const SkillLinkEvents = {
  "skills.linkProgress": z.strictObject({
    sourceId: IdSchema,
    phase: z.enum(["downloading", "scanning"]),
    bytes: z.number().int().nonnegative().max(SKILL_IMPORT_MAX_BYTES),
    totalBytes: z.number().int().nonnegative().max(SKILL_IMPORT_MAX_BYTES).nullable(),
  }),
} as const;
