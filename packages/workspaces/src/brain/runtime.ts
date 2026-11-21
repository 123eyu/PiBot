import type { WorkspaceLocal } from "@pibot/brain/kit";
export const resolveRunWorkplace = (
  local: WorkspaceLocal,
  ...args: Parameters<WorkspaceLocal["runtime"]["workplace"]>
) => local.runtime.workplace(...args);
export const groupWorkplace = (
  local: WorkspaceLocal,
  ...args: Parameters<WorkspaceLocal["runtime"]["groupWorkplace"]>
) => local.runtime.groupWorkplace(...args);
export const runPermissions = (
  local: WorkspaceLocal,
  ...args: Parameters<WorkspaceLocal["runtime"]["permissions"]>
) => local.runtime.permissions(...args);
export const authorizationSnapshot = (
  local: WorkspaceLocal,
  ...args: Parameters<WorkspaceLocal["runtime"]["authorization"]>
) => local.runtime.authorization(...args);
export const groupAuthorization = (
  local: WorkspaceLocal,
  ...args: Parameters<WorkspaceLocal["runtime"]["groupAuthorization"]>
) => local.runtime.groupAuthorization(...args);
export const runYolo = (
  local: WorkspaceLocal,
  ...args: Parameters<WorkspaceLocal["runtime"]["yolo"]>
) => local.runtime.yolo(...args);
export const auditYolo = (
  local: WorkspaceLocal,
  ...args: Parameters<WorkspaceLocal["runtime"]["auditYolo"]>
) => local.runtime.auditYolo(...args);
