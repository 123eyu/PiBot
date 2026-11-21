import type {
  GroupOrchestrationPort,
  LocalService,
  OrchestrationFactory,
} from "@pibot/brain/orchestration-kit";
import { createGroupPlanEngine } from "./conversations/groups/group-plan-engine.ts";
import type { GroupPlanEngine } from "./conversations/groups/group-plans.ts";
import { registerGroupRpc } from "./conversations/groups/group-rpc.ts";
import { GroupService } from "./conversations/groups/group-service.ts";
import { ExecutionCleanup } from "./runtime/tasks/execution-cleanup.ts";
import { registerExecutionCollectionRpc } from "./runtime/tasks/execution-collection.ts";
import { ExecutionService, registerExecutionRpc } from "./runtime/tasks/execution-service.ts";
import { registerTaskRpc } from "./runtime/tasks/task-rpc.ts";
import { TaskService } from "./runtime/tasks/task-service.ts";

export { validateGroupPlan } from "./conversations/groups/group-plan-validation.ts";
export type { GroupPlanEngine } from "./conversations/groups/group-plans.ts";

export function createOrchestrationFactory(
  options: { groupPlanEngine?(groups: GroupOrchestrationPort): GroupPlanEngine } = {},
): OrchestrationFactory {
  const localServices = new WeakMap<LocalService, ExecutionService>();
  const groupServices = new WeakMap<GroupOrchestrationPort, GroupService>();
  return {
    createLocal(local) {
      const execution = new ExecutionService(local);
      localServices.set(local, execution);
      return {
        runCleanup: new ExecutionCleanup(),
        execution,
        tasks: new TaskService(local, local.budgets),
      };
    },
    createGroups(deps) {
      const groups = new GroupService(deps);
      groups.plans.provide(options.groupPlanEngine?.(groups) ?? createGroupPlanEngine(groups));
      groupServices.set(groups, groups);
      return groups;
    },
    registerLocalRpc(handle, local) {
      const execution = localServices.get(local);
      if (!execution) throw new Error("Orchestration local services unavailable");
      registerExecutionCollectionRpc(handle, local);
      registerExecutionRpc(handle, execution);
      registerTaskRpc(handle, local);
    },
    registerGroupRpc(handle, groups, runs) {
      const service = groupServices.get(groups);
      if (!service) throw new Error("Orchestration group service unavailable");
      registerGroupRpc(handle, service, runs);
    },
  };
}
