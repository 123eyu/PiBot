export const VERDICT_ROLE_IDS: readonly string[] = ["qa-engineer", "code-reviewer"];
export function isVerdictRole(roleId: string | undefined): boolean {
  return roleId !== undefined && VERDICT_ROLE_IDS.includes(roleId);
}

/** Built-in engineering category, excluding the verification roles; Bot rows retain only role ids. */
export const IMPLEMENTATION_ROLE_IDS: readonly string[] = [
  "devops",
  "backend-dev",
  "plugin-builder",
  "frontend-dev",
  "tech-writer",
  "fullstack-dev",
];
export function isImplementationRole(roleId: string | undefined): boolean {
  return roleId !== undefined && IMPLEMENTATION_ROLE_IDS.includes(roleId);
}
