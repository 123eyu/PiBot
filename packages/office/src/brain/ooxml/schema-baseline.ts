import { Buffer } from "node:buffer";
import type { OfficePackage } from "./package.ts";
import type { SchemaFinding } from "./schema.ts";
import type { validatePackageDetailed } from "./validate.ts";

type Report = ReturnType<typeof validatePackageDetailed>;

function findingKey(finding: SchemaFinding) {
  return JSON.stringify([finding.part, finding.rule, [...finding.dependencies].sort()]);
}

export function withoutPreexistingSchemaIssues(
  after: Report,
  before: Report,
  candidate: OfficePackage,
  baseline: OfficePackage,
) {
  const matches = new Map<string, number>();
  for (const [index, finding] of before.schemaFindings) {
    const issue = before.validation.issues[index];
    if (issue?.code !== "invalid_schema" || issue.severity !== "serious") continue;
    const key = findingKey(finding);
    matches.set(key, (matches.get(key) ?? 0) + 1);
  }
  const unchanged = new Map<string, boolean>();
  const samePart = (part: string) => {
    const cached = unchanged.get(part);
    if (cached !== undefined) return cached;
    const old = baseline.readPart(part),
      next = candidate.readPart(part);
    const same = old !== undefined && next !== undefined && Buffer.compare(old, next) === 0;
    unchanged.set(part, same);
    return same;
  };
  let moved = 0;
  const issues = after.validation.issues.map((issue, index) => {
    const finding = after.schemaFindings.get(index);
    if (issue.code !== "invalid_schema" || issue.severity !== "serious" || !finding) return issue;
    const key = findingKey(finding),
      remaining = matches.get(key) ?? 0;
    // Cross-part checks also depend on the referenced bytes, not just the reporting part.
    if (!remaining || ![finding.part, ...finding.dependencies].every(samePart)) return issue;
    matches.set(key, remaining - 1);
    moved++;
    return { ...issue, severity: "notice" as const };
  });
  return {
    serious: after.validation.serious - moved,
    notices: after.validation.notices + moved,
    issues,
  };
}
