import type { ActivityState } from "./activity-types.ts";
export const emptyActivity: ActivityState = { tools: [], approvals: [], error: false };
export function groupActivity(state: ActivityState, previous: Map<string, ActivityState>) {
  const groups = new Map<string, ActivityState>();
  const group = (id: string) => {
    let value = groups.get(id);
    if (!value) {
      value = { tools: [], approvals: [], error: false };
      groups.set(id, value);
    }
    return value;
  };
  for (const tool of state.tools) group(tool.messageId).tools.push(tool);
  for (const approval of state.approvals) group(approval.messageId).approvals.push(approval);
  if (state.runActivity) group(state.runActivity.messageId).runActivity = state.runActivity;
  for (const [id, value] of groups) {
    const old = previous.get(id);
    if (
      old &&
      old.runActivity === value.runActivity &&
      old.tools.length === value.tools.length &&
      old.approvals.length === value.approvals.length &&
      old.tools.every((tool, index) => tool === value.tools[index]) &&
      old.approvals.every((approval, index) => approval === value.approvals[index])
    )
      groups.set(id, old);
  }
  return groups;
}
