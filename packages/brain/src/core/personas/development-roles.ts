/**
 * Roles that write or review code see `code_navigate` from the run's first turn.
 *
 * The ids are the built-in roles whose `team.json` declares `category: "engineering"`
 * (`packages/teams/builtin/roles/<id>.pibot/team.json`), plus `ui-ux-designer`: its
 * prototype-preview skill edits and runs the project's own stack, so it reads code like the
 * engineering roles do. Brain sits below the teams package (layers L3 vs L5), so it
 * cannot read that content and the set is repeated here; keep both in sync when a built-in role
 * starts reading or writing code.
 */
const developmentRoles = new Set([
  "devops",
  "backend-dev",
  "code-reviewer",
  "frontend-dev",
  "fullstack-dev",
  "tech-writer",
  "qa-engineer",
  "ui-ux-designer",
]);

export function developmentRole(roleId: string | undefined): boolean {
  return !!roleId && developmentRoles.has(roleId);
}
