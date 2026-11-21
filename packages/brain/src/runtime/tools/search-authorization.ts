import { ExecError } from "@pibot/execution";
import type { ToolRunContext } from "../../core/local-types.ts";
import type { LocalService } from "../../local-service.ts";
import { authorizationSnapshot } from "./local-prepare.ts";

/** SQLite writes invalidate the memo, including rolled-back writes on this connection. */
export function searchAuthorization(local: LocalService, context: ToolRunContext) {
  const version = local.deps.db.prepare(
    "SELECT total_changes() AS writes, data_version AS external FROM pragma_data_version",
  );
  let previous = "";
  let authorization = "";
  let memory = "";
  return () => {
    // These sources can change in memory without a database write. Never memoize their identity.
    const current = JSON.stringify([
      local.deps.search?.snapshot(),
      local.tasks.hasAuthority(context),
      context.executionTaskId,
      context.routineWorkplace,
      context.runWorkplace,
      context.topicWorkplace,
      context.workflowReadRoots,
      context.groupAuthorization,
      context.todoRun?.planVersion,
    ]);
    if (memory && current !== memory) throw new ExecError("outside_workplace");
    memory = current;
    const revision = JSON.stringify(version.get());
    if (revision !== previous) {
      authorization = authorizationSnapshot(local, context.botId, context);
      previous = revision;
    }
    return authorization;
  };
}
