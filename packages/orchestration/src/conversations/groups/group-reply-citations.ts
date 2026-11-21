import { deliverySources, replyCitationFacts } from "@pibot/brain/orchestration-kit";
import type { Message } from "@pibot/protocol-base";
import { BotsRepo, MessagesRepo } from "@pibot/storage";
import type { GroupService } from "./group-service.ts";

/** An explicit finish can publish a thread's result before chat-run writes its final metadata. */
export function annotateResearchResult(
  service: GroupService,
  message: Message,
  runId: string | undefined,
  taskId: string,
) {
  if (!runId || service.handoffs.repo.get(taskId)?.spec.workflowStep) return;
  const run = service.runs.get(runId);
  if (
    !run ||
    run.taskId !== taskId ||
    run.botId !== message.botId ||
    run.groupId !== service.tasks.get(taskId)?.groupId
  )
    return;
  const bot = new BotsRepo(service.deps.db).get(run.botId);
  if (!["researcher", "data-analyst"].includes(bot?.role?.id ?? "")) return;
  const check = replyCitationFacts(
    message.content,
    deliverySources(service.deps.db, runId),
    service.signal,
  );
  if (!check) return;
  const usage =
    message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)
      ? message.usage
      : {};
  new MessagesRepo(service.deps.db).update(message.id, {
    usage: { ...usage, replyCitations: check },
  });
}
