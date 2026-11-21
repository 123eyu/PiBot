import type { GroupTask, MethodResults } from "@pibot/protocol";

type ExecutionTask = MethodResults["groups.execution.tasks"]["items"][number];
export function groupTaskIsChild(task: GroupTask, coordinatorBotId: string) {
  return !(
    task.source?.kind === "user" &&
    task.assigneeBotId === coordinatorBotId &&
    !task.source.parentTaskId
  );
}
export type GroupTaskNode = {
  id: string;
  main?: boolean;
  assignment?: GroupTask;
  execution?: ExecutionTask;
  children: GroupTaskNode[];
};

/** Dispatch receipts and execution children share one tree; a run is never another task. */
export function groupTaskTree(
  assignments: readonly GroupTask[],
  executions: readonly ExecutionTask[],
  coordinatorBotId: string,
) {
  const nodes = new Map<string, GroupTaskNode>(),
    parents = new Map<string, string>();
  for (const task of assignments) {
    const id = `group:${task.id}`;
    nodes.set(id, {
      id,
      main: !groupTaskIsChild(task, coordinatorBotId),
      assignment: task,
      children: [],
    });
    if (task.source?.parentTaskId) parents.set(id, `group:${task.source.parentTaskId}`);
  }
  const executionIds = new Set(executions.map((task) => task.id));
  for (const task of executions) {
    const id = `execution:${task.id}`;
    nodes.set(id, { id, execution: task, children: [] });
    if (task.parentTaskId && executionIds.has(task.parentTaskId))
      parents.set(id, `execution:${task.parentTaskId}`);
    else if (task.groupTaskId) parents.set(id, `group:${task.groupTaskId}`);
  }
  const roots: GroupTaskNode[] = [];
  for (const node of nodes.values()) {
    const seen = new Set([node.id]);
    const parentId = parents.get(node.id);
    const parent = parentId ? nodes.get(parentId) : undefined;
    // Corrupt ancestry stays visible as a root rather than disappearing or recursing forever.
    let cursor = parentId,
      cyclic = false;
    while (cursor) {
      if (seen.has(cursor)) {
        cyclic = true;
        break;
      }
      seen.add(cursor);
      cursor = parents.get(cursor);
    }
    if (parent && !cyclic) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
export function groupTaskNodeActive(node: GroupTaskNode): boolean {
  return (
    node.assignment?.status === "open" ||
    (!!node.execution &&
      ["queued", "running", "stopping", "error", "interrupted"].includes(node.execution.status)) ||
    node.children.some(groupTaskNodeActive)
  );
}
