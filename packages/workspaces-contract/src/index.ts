import { GroupTopicMethods, type Params, type Payload, type Result } from "@pibot/protocol-base";
import { type ChangesEvents, ChangesMethods } from "./api/changes.ts";
import { FileCheckpointMethods } from "./api/file-checkpoints.ts";
import { ManagedWorktreeMethods } from "./api/managed-worktrees.ts";

export {
  ChangesEvents,
  ChangesMethods,
  type GitSetupStatus,
  GitSetupStatusSchema,
} from "./api/changes.ts";
export { FileCheckpointMethods } from "./api/file-checkpoints.ts";
export { ManagedWorktreeMethods } from "./api/managed-worktrees.ts";

export const WorkspacesContractMethods = {
  ...ChangesMethods,
  ...FileCheckpointMethods,
  ...ManagedWorktreeMethods,
  ...GroupTopicMethods,
} as const;
export type WorkspaceMethodParams = {
  [K in keyof typeof WorkspacesContractMethods]: Params<typeof WorkspacesContractMethods, K>;
};
export type WorkspaceMethodResults = {
  [K in keyof typeof WorkspacesContractMethods]: Result<typeof WorkspacesContractMethods, K>;
};
export type WorkspaceEventPayloads = {
  [K in keyof typeof ChangesEvents]: Payload<typeof ChangesEvents, K>;
};
