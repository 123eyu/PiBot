import {
  type SkillContract,
  type WorkflowDocument,
  WorkflowDocumentSchema,
} from "@pibot/skills-contract/full";

export function contractFromDocument(document: { contract?: string }): SkillContract | undefined {
  if (!document.contract) return undefined;
  try {
    const parsed = WorkflowDocumentSchema.shape.contract.safeParse(JSON.parse(document.contract));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function matchesSavedDocument(
  stored: {
    name: string;
    description: string;
    body: string;
    params: WorkflowDocument["params"];
    contract?: string;
  },
  expected: WorkflowDocument,
) {
  const contract = contractFromDocument(stored);
  if (!contract) return false;
  // Readback also carries version/verification metadata, outside the editor's strict schema.
  const parsed = WorkflowDocumentSchema.safeParse({
    name: stored.name,
    description: stored.description,
    body: stored.body,
    params: stored.params,
    contract,
  });
  const wanted = WorkflowDocumentSchema.safeParse(expected);
  return (
    parsed.success && wanted.success && JSON.stringify(parsed.data) === JSON.stringify(wanted.data)
  );
}
