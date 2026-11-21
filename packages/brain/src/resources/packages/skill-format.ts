import { createHash, randomBytes } from "node:crypto";
import {
  type SkillContract,
  SkillContractSchema,
  type SkillDocument,
  SkillVerifiedMetadataSchema,
  type WorkflowVerification,
  type WorkflowWarning,
} from "@pibot/protocol-base";

// The plain-text SKILL.md format is shared with the renderer's editor (protocol-base).
export {
  importedDocument,
  type ParsedSkillFile,
  parseSkillFile,
  renderSkillFile,
  storedContract,
  storedParams,
  storedVerified,
  storedVersion,
  storedWorkflow,
} from "@pibot/protocol-base";

/** The checker warns above these (body lines, hard stop rules). */
export const WORKFLOW_BODY_LINES = 60;
export const WORKFLOW_STOP_RULES = 3;

/**
 * The work contract of a skill, validated. A missing contract is an ordinary skill (null,
 * no warnings); an invalid one is still an ordinary skill, reported as `contract_invalid` so the
 * interface and the built-in checker can say so. Never throws.
 */
export function skillContract(
  document: Pick<SkillDocument, "body" | "contract" | "version" | "verified">,
  rawVersion?: string,
): {
  contract: SkillContract | null;
  verified: WorkflowVerification | null;
  warnings: WorkflowWarning[];
} {
  const warnings: WorkflowWarning[] = [];
  if (rawVersion?.trim() && document.version === undefined) warnings.push("version_invalid");
  const verification = SkillVerifiedMetadataSchema.safeParse(document.verified);
  const verified = verification.success ? verification.data : null;
  if (document.verified !== undefined && !verification.success)
    warnings.push("verification_invalid");
  if (document.contract === undefined) return { contract: null, verified, warnings };
  let contract: SkillContract | null = null;
  try {
    const parsed = SkillContractSchema.safeParse(JSON.parse(document.contract));
    if (parsed.success) contract = parsed.data;
  } catch {
    // Not JSON: reported below like any other invalid contract.
  }
  if (!contract) return { contract: null, verified, warnings: [...warnings, "contract_invalid"] };
  const lines = document.body.split("\n").filter((line) => line.trim()).length;
  if (lines > WORKFLOW_BODY_LINES) warnings.push("body_too_long");
  if (contract.stop.length > WORKFLOW_STOP_RULES) warnings.push("too_many_stop_rules");
  if (!contract.deliverables.length && !contract.steps?.some((step) => step.deliverables.length))
    warnings.push("no_deliverables");
  if (!contract.acceptance.length && !contract.steps?.some((step) => step.acceptance.length))
    warnings.push("no_acceptance");
  return { contract, verified, warnings };
}

/** Agent Skills folder name: lowercase ASCII words joined by `-`, random when the name has none. */
export function skillSlug(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return ascii.length >= 2 ? ascii : `skill-${randomBytes(4).toString("hex")}`;
}

/**
 * Identifies a skill's content (display name, description, body, parameters and supporting
 * files) independent of how SKILL.md is laid out, so a built-in package and the copy saved for a
 * Bot compare equal until someone edits or renames it. Short hex: change detection, not security.
 */
export function skillFingerprint(
  document: Pick<SkillDocument, "name" | "description" | "body" | "params"> &
    Partial<Pick<SkillDocument, "version" | "contract" | "verified">>,
  files: readonly ({ path: string; data: Buffer } | { path: string; digest: string })[],
): string {
  const hash = createHash("sha256");
  // Workflow metadata joins the hash only when present, so fingerprints recorded before it are
  // kept.
  const workflow: unknown[] =
    document.version !== undefined || document.contract !== undefined
      ? [document.version ?? null, document.contract ?? null]
      : [];
  // Keep fingerprints from before the verified marker stable when it is absent.
  if (document.verified !== undefined) workflow.push(document.verified);
  hash.update(
    JSON.stringify([
      document.name,
      document.description,
      document.body,
      document.params,
      ...workflow,
    ]),
  );
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
    hash.update(
      `\0${file.path}\0${"digest" in file ? file.digest : createHash("sha256").update(file.data).digest("hex")}`,
    );
  return hash.digest("hex").slice(0, 16);
}

/** Short content hash of one text field (norms, announcement) for built-in provenance. */
export function textFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Hash resources in bounded chunks, preserving all existing provenance fingerprints. */
export async function skillResourceDigests(
  files: readonly import("./skill-source.ts").SkillSourceFile[],
  signal: AbortSignal,
) {
  const result: { path: string; digest: string }[] = [];
  for (const file of files) {
    if (file.path === "SKILL.md" || file.path.startsWith(".SKILL.md.")) continue;
    const hash = createHash("sha256");
    for await (const chunk of file.chunks(signal)) {
      signal.throwIfAborted();
      hash.update(chunk);
    }
    result.push({ path: file.path, digest: hash.digest("hex") });
  }
  return result;
}
