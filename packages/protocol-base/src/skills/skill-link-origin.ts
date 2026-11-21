import { z } from "zod";

/** Provenance is display/update input, never a permission or an authenticity claim. */
export const SkillLinkOriginSchema = z.strictObject({
  host: z.string().min(1).max(253),
  url: z
    .url()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash
        );
      } catch {
        return false;
      }
    }),
  owner: z.string().min(1).max(100).optional(),
  repo: z.string().min(1).max(100).optional(),
  ref: z.string().min(1).max(512).optional(),
  commit: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
  subpath: z.string().max(512),
  downloadedAt: z.iso.datetime(),
});
export type SkillLinkOrigin = z.output<typeof SkillLinkOriginSchema>;
