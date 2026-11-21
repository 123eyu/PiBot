import {
  type GitConfigurationFacts,
  normalizeSensitiveGitConfigurationKey,
} from "@pibot/protocol-base";

export interface GitConfigurationClassification {
  kind:
    | "not-applicable"
    | "ordinary-project-candidate"
    | "managed-branch-candidate"
    | "mandatory-global-confirmation"
    | "mandatory-hooks-path-confirmation"
    | "mandatory-project-confirmation"
    | "protected"
    | "unsupported";
  risk: "normal" | "danger";
  confirmation: "none" | "once";
  canRemember: false;
  authority: "none";
}

/** Describes a candidate only; the existing evaluator remains the sole permission decision. */
export function classifyGitConfiguration(
  facts: GitConfigurationFacts,
): GitConfigurationClassification {
  const base = { canRemember: false as const, authority: "none" as const };
  if (
    facts.operation === "hooks-path" &&
    facts.status === "candidate" &&
    facts.scope === "project" &&
    facts.reason === "hooks_path_candidate" &&
    facts.requestedKey === "core.hookspath" &&
    facts.hooksPathVersion &&
    facts.candidateDigest &&
    facts.beforeVersion &&
    facts.intentDigest &&
    facts.targetPath &&
    JSON.stringify(facts.changedKeys) === JSON.stringify([facts.requestedKey])
  )
    return {
      ...base,
      kind: "mandatory-hooks-path-confirmation",
      risk: "danger",
      confirmation: "once",
    };
  if (facts.status === "not-applicable")
    return { ...base, kind: "not-applicable", risk: "normal", confirmation: "none" };
  if (facts.reason === "protected_scope" || facts.scope === "system")
    return { ...base, kind: "protected", risk: "danger", confirmation: "none" };
  if (
    facts.status === "candidate" &&
    facts.reason === "managed_branch_candidate" &&
    facts.scope === "project" &&
    facts.targetPath &&
    facts.intentDigest &&
    facts.candidateDigest &&
    facts.beforeVersion &&
    facts.changedKeys.length === 1 &&
    facts.changedKeys[0] === facts.requestedKey
  )
    return { ...base, kind: "managed-branch-candidate", risk: "normal", confirmation: "none" };
  if (
    facts.status === "confirmation-required" &&
    facts.scope === "project" &&
    facts.reason === "sensitive_project_confirmation_required" &&
    facts.operation === undefined &&
    facts.requestedKey !== undefined &&
    normalizeSensitiveGitConfigurationKey(facts.requestedKey) === facts.requestedKey &&
    facts.resolvedBranch === undefined &&
    facts.targetPath &&
    facts.intentDigest &&
    facts.candidateDigest &&
    facts.beforeVersion &&
    JSON.stringify(facts.changedKeys) === JSON.stringify([facts.requestedKey])
  )
    return {
      ...base,
      kind: "mandatory-project-confirmation",
      risk: "danger",
      confirmation: "once",
    };
  if (
    facts.status === "candidate" &&
    facts.scope === "project" &&
    facts.reason === "ordinary_project_candidate" &&
    !normalizeSensitiveGitConfigurationKey(facts.requestedKey ?? "") &&
    facts.targetPath &&
    facts.intentDigest &&
    facts.candidateDigest &&
    facts.beforeVersion &&
    facts.changedKeys[0] === facts.requestedKey &&
    (facts.changedKeys.length === 1 ||
      (facts.changedKeys.length === 2 &&
        ((/^remote\..+\.url$/.test(facts.requestedKey ?? "") &&
          facts.resolvedBranch === undefined &&
          facts.changedKeys[1] === `${facts.requestedKey?.slice(0, -4)}.fetch`) ||
          (facts.resolvedBranch !== undefined &&
            facts.requestedKey === `branch.${facts.resolvedBranch}.remote` &&
            facts.changedKeys[1] === `branch.${facts.resolvedBranch}.merge`))))
  )
    return { ...base, kind: "ordinary-project-candidate", risk: "normal", confirmation: "none" };
  if (
    facts.status === "confirmation-required" &&
    facts.scope === "global" &&
    /^user\.(?:name|email)$/.test(facts.requestedKey ?? "") &&
    facts.reason === "global_confirmation_required"
  )
    return { ...base, kind: "mandatory-global-confirmation", risk: "danger", confirmation: "once" };
  return { ...base, kind: "unsupported", risk: "danger", confirmation: "none" };
}
