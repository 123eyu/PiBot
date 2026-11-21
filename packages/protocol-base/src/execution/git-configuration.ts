import { z } from "zod";

/** Preparation diagnostics, never an approval or executable resource capability. */
export const GitConfigurationFactsSchema = z.object({
  version: z.literal(1),
  operation: z.enum(["known-file", "hooks-path"]).optional(),
  hooksPathVersion: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  status: z.enum(["not-applicable", "unsupported", "candidate", "confirmation-required"]),
  scope: z.enum(["project", "global", "system"]).optional(),
  reason: z.enum([
    "not_config_setter",
    "unsupported_syntax",
    "unsupported_program",
    "protected_scope",
    "unsupported_key",
    "invalid_value",
    "credential_value",
    "shared_metadata",
    "scope_unverified",
    "changed",
    "includes_unknown",
    "candidate_failed",
    "global_confirmation_required",
    "sensitive_project_confirmation_required",
    "ordinary_project_candidate",
    "managed_branch_candidate",
    "hooks_path_candidate",
  ]),
  requestedKey: z.string().max(512).optional(),
  /** Trusted execution fact for the fixed upstream recipe, never a model authorization input. */
  resolvedBranch: z.string().min(1).max(256).optional(),
  intentDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  targetPath: z.string().min(1).max(4096).optional(),
  beforeVersion: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  candidateDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  changedKeys: z.array(z.string().max(512)).max(2),
  authority: z.literal("none"),
});
export type GitConfigurationFacts = z.infer<typeof GitConfigurationFactsSchema>;

/**
 * Pure intent vocabulary for project keys whose value names a program, never an approval.
 * core.hooksPath has its own stricter recipe (`operation: "hooks-path"`) and is not listed here.
 */
export function normalizeSensitiveGitConfigurationKey(key: string): string | undefined {
  if (/^(?:core\.sshcommand|credential\.helper)$/i.test(key)) return key.toLowerCase();
  const match = /^filter\.(.+)\.(clean|smudge|process)$/i.exec(key);
  const name = match?.[1],
    variable = match?.[2]?.toLowerCase();
  if (
    !name ||
    !variable ||
    name.length > 256 ||
    [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    /[\s~^:?*[\\]/.test(name) ||
    name.includes("..") ||
    name.includes("@{") ||
    name.startsWith("-") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".lock") ||
    name.endsWith(".")
  )
    return undefined;
  // Git compares subsection names case-sensitively; only section and variable are folded.
  return `filter.${name}.${variable}`;
}

/** Changes that the person must confirm each time; YOLO, grants and routines never answer. */
export function gitConfigurationNeedsConfirmation(
  facts: Pick<GitConfigurationFacts, "scope" | "reason">,
): boolean {
  return (
    (facts.scope === "global" && facts.reason === "global_confirmation_required") ||
    (facts.scope === "project" && facts.reason === "sensitive_project_confirmation_required")
  );
}
