import { z } from "zod";

/** Fixed categories of a recognized command-sandbox block. */
export const SandboxBlockKindSchema = z.enum([
  "outside_workplace_write",
  "protected_name",
  "git_resource",
  "network",
  "local_service",
  "system_service",
  "protected_path",
  "credential_read",
  "protected_read",
  "other",
]);
export type SandboxBlockKind = z.infer<typeof SandboxBlockKindSchema>;

/** A listed command shape — program, optional fixed arguments, optional trailing `*`. */
export const OutsideCommandPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\s*]+(?: [^\s*]+)*(?: \*)?$/);
export const OutsideCommandPatternsSchema = z.array(OutsideCommandPatternSchema).max(32);
