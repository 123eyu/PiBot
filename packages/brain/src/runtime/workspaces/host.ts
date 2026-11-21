import type { ChatService } from "../../conversations/chat/chat.ts";
import type { GroupOrchestrationPort } from "../../core/orchestration.ts";
import { runPermissions } from "../../core/run-permissions.ts";
import { auditYolo, runYolo } from "../../core/yolo.ts";
import type { LocalService } from "../../local-service.ts";
import { groupWorkplace } from "../../resources/groups/group-workplace.ts";
import { resolveRunWorkplace } from "../../resources/workplaces/run-workplace.ts";
import { runnerWorkplace } from "../../resources/workplaces/runner-workplace.ts";
import type { TopicWorkplaceService } from "../../resources/workplaces/topic-workplace.ts";
import { workspaceFiles } from "../../resources/workplaces/workspace-files.ts";
import { authorizationSnapshot, groupAuthorization } from "../tools/local-prepare.ts";
import type { ChangesPort } from "./port.ts";
/** Only the runtime services workspace operations need; no queue instance or mutable engine ownership. */
export interface WorkspaceLocal
  extends Pick<
    LocalService,
    | "deps"
    | "approvals"
    | "background"
    | "target"
    | "targetFor"
    | "execution"
    | "getPolicy"
    | "permissions"
    | "reviews"
    | "shutdown"
    | "tasks"
    | "workplaces"
    | "writeLocks"
  > {
  readonly changes: ChangesPort;
  readonly runtime: {
    workplace(
      ...args: Tail<Parameters<typeof resolveRunWorkplace>>
    ): ReturnType<typeof resolveRunWorkplace>;
    groupWorkplace(
      ...args: Tail<Parameters<typeof groupWorkplace>>
    ): ReturnType<typeof groupWorkplace>;
    permissions(
      ...args: Tail<Parameters<typeof runPermissions>>
    ): ReturnType<typeof runPermissions>;
    authorization(
      ...args: Tail<Parameters<typeof authorizationSnapshot>>
    ): ReturnType<typeof authorizationSnapshot>;
    groupAuthorization(
      ...args: Tail<Parameters<typeof groupAuthorization>>
    ): ReturnType<typeof groupAuthorization>;
    yolo(...args: Tail<Parameters<typeof runYolo>>): ReturnType<typeof runYolo>;
    auditYolo(...args: Tail<Parameters<typeof auditYolo>>): ReturnType<typeof auditYolo>;
    /** File access of a (runner) workplace. */
    files(...args: Tail<Parameters<typeof workspaceFiles>>): ReturnType<typeof workspaceFiles>;
    /** Boundary of folders on one runner. */
    runnerWorkplace(
      value: Parameters<typeof runnerWorkplace>[0],
      signal: AbortSignal,
    ): ReturnType<typeof runnerWorkplace>;
  };
}
type Tail<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never;
export interface WorkspaceChat {
  readonly queue: Pick<ChatService["queue"], "resources" | "insert" | "publish"> & {
    readonly repo: Pick<ChatService["queue"]["repo"], "get">;
  };
}
export interface WorkspaceGroups
  extends Pick<GroupOrchestrationPort, "active" | "changing" | "taskChanged" | "tasks"> {
  readonly folders: Pick<GroupOrchestrationPort["folders"], "bindManaged">;
  readonly wakes: Pick<GroupOrchestrationPort["wakes"], "enqueue">;
  readonly deps: { readonly local: WorkspaceLocal; readonly chat: WorkspaceChat };
}
export type WorkspaceTopics = Pick<TopicWorkplaceService, "update">;
export interface WorkspaceHost {
  readonly local: WorkspaceLocal;
  readonly chat: WorkspaceChat;
  readonly groups: WorkspaceGroups;
  readonly topics: WorkspaceTopics;
}
export function createWorkspaceHost(
  local: LocalService,
  chat: ChatService,
  groups: GroupOrchestrationPort,
  topics: TopicWorkplaceService,
): WorkspaceHost {
  const adapter = createWorkspaceLocal(local);
  const queue: WorkspaceChat["queue"] = {
    repo: { get: chat.queue.repo.get.bind(chat.queue.repo) },
    resources: () => chat.queue.resources(),
    insert: (...args) => chat.queue.insert(...args),
    publish: (...args) => chat.queue.publish(...args),
  };
  const route: WorkspaceChat = { queue };
  return {
    local: adapter,
    chat: route,
    topics: { update: topics.update.bind(topics) },
    groups: {
      active: groups.active.bind(groups),
      changing: groups.changing.bind(groups),
      taskChanged: groups.taskChanged.bind(groups),
      tasks: groups.tasks,
      folders: { bindManaged: groups.folders.bindManaged.bind(groups.folders) },
      wakes: { enqueue: groups.wakes.enqueue.bind(groups.wakes) },
      deps: { local: adapter, chat: route },
    },
  };
}

/** Projection shared by the full host and existing isolated implementation probes. */
export function createWorkspaceLocal(local: LocalService): WorkspaceLocal {
  return {
    deps: local.deps,
    approvals: local.approvals,
    background: local.background,
    target: local.target,
    targetFor: local.targetFor.bind(local),
    execution: local.execution,
    getPolicy: local.getPolicy.bind(local),
    permissions: local.permissions,
    reviews: local.reviews,
    shutdown: local.shutdown,
    tasks: local.tasks,
    workplaces: local.workplaces,
    writeLocks: local.writeLocks,
    get changes() {
      return local.changes;
    },
    runtime: {
      workplace: (...args) => resolveRunWorkplace(local, ...args),
      groupWorkplace: (...args) => groupWorkplace(local, ...args),
      permissions: (...args) => runPermissions(local, ...args),
      authorization: (...args) => authorizationSnapshot(local, ...args),
      groupAuthorization: (...args) => groupAuthorization(local, ...args),
      yolo: (...args) => runYolo(local, ...args),
      auditYolo: (...args) => auditYolo(local, ...args),
      files: (...args) => workspaceFiles(local, ...args),
      runnerWorkplace: (value, signal) => runnerWorkplace(value, local.executionTargets, signal),
    },
  };
}
