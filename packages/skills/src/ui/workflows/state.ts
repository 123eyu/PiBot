import type { WorkflowBinding, WorkflowSummary } from "@pibot/skills-contract/full";

export function workflowDefaults(workflow: WorkflowSummary): WorkflowBinding {
  return {
    skillId: workflow.skillId,
    params: Object.fromEntries(
      workflow.params
        .filter((param) => param.default !== undefined)
        .map((param) => [param.name, param.default ?? ""]),
    ),
    inputs: {},
  };
}

/** Path comparison only decides whether to show a warning; the brain remains the authority. */
export function pathInFolders(path: string, folders: readonly string[]): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const folded = /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
  return folders.some((folder) => {
    const rootValue = folder.replaceAll("\\", "/").replace(/\/+$/, "");
    const root = /^[A-Za-z]:\//.test(rootValue) ? rootValue.toLowerCase() : rootValue;
    return folded === root || folded.startsWith(`${root}/`);
  });
}
