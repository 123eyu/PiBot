import { z } from "zod";

// What this computer already has, so the Knowledge tab can offer what is here instead of
// sending the person hunting for a folder. The host answers it; nothing inside a vault or the
// Notion app is read, and the renderer only ever sees names and paths.
const noParams = z.union([z.undefined(), z.strictObject({})]);
const path = z
  .string()
  .min(1)
  .max(32768)
  .refine((value) => !value.includes("\0"));

export const KnowledgeVaultSchema = z.strictObject({
  /** The vault folder's own name; the store's display name wins once the source exists. */
  name: z.string().min(1).max(200),
  path,
});
export type KnowledgeVault = z.output<typeof KnowledgeVaultSchema>;

/** Unsupported platforms answer this empty shape rather than an error: nothing found is normal. */
export const KnowledgeDetectionSchema = z.strictObject({
  obsidian: z.strictObject({
    installed: z.boolean(),
    // Bounded like the lists around it: someone's Obsidian account never holds more than a page
    // of vaults, and the tab adds them one at a time.
    vaults: z.array(KnowledgeVaultSchema).max(50),
  }),
  notion: z.strictObject({ installed: z.boolean() }),
});
export type KnowledgeDetection = z.output<typeof KnowledgeDetectionSchema>;

/**
 * Host-side detection only ("read another app's own listing, only when asked"): the
 * brain never guesses platform paths, and this call reads no note or workspace content.
 */
export const KnowledgeDetectHostMethods = {
  "host.knowledge.detect": { params: noParams, result: KnowledgeDetectionSchema },
} as const;
