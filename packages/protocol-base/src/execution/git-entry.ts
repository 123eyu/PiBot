import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);

/** Reasons a Git command that would run project code is refused instead of asked about. */
export const GitEntryRefusalSchema = z.enum([
  "include_unknown",
  "layout_unsupported",
  "scan_incomplete",
  "compound",
  "dynamic",
  "unsupported_target",
]);
export type GitEntryRefusal = z.infer<typeof GitEntryRefusalSchema>;

/**
 * Host observations: which project hooks / executable config entries an ordinary Git
 * command would run. Paths and hashes only; config values and script bodies never cross this
 * boundary, and these facts grant nothing (the private plan is re-verified before launch).
 */
export const GitEntryFactsSchema = z.strictObject({
  version: z.literal(1),
  status: z.enum(["confirmation-required", "unsupported"]),
  reason: z.union([z.literal("entries_found"), GitEntryRefusalSchema]),
  entries: z
    .array(
      z.strictObject({
        kind: z.enum(["hook", "config"]),
        name: z.string().min(1).max(256),
        source: z.string().min(1).max(4096),
        sha256: hash,
      }),
    )
    .max(32),
  digest: hash.optional(),
  authority: z.literal("none"),
});
export type GitEntryFacts = z.infer<typeof GitEntryFactsSchema>;
