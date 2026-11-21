import type { ToolRunContext } from "../../core/local-types.ts";

/**
 * The run's local primary folder is its project. A Bot's own folder ("home") is not a
 * project, and remote targets (runner / ACP) have paths that mean nothing on this machine.
 */
export function memoryProjectPath(context: Pick<ToolRunContext, "runWorkplace">) {
  const boundary = context.runWorkplace?.boundary;
  if (!boundary || boundary.primaryId === "home") return undefined;
  const target = boundary.location?.target;
  if (target && target !== "local") return undefined;
  return boundary.roots.find((root) => root.role === "primary")?.canonicalPath;
}
