import type { LocalToolCall, LocalToolResult } from "@pibot/agent";
import {
  type PersonalTodo,
  PersonalTodoToolSchema,
  personalTodoBotColor,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import { BotsRepo, PersonalTodosRepo, transaction } from "@pibot/storage";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { ToolRunContext } from "../../core/local-types.ts";
import { redactValue } from "../../core/privacy.ts";
import type { LocalService } from "../../local-service.ts";
import { canAskUser } from "../../runtime/questions/user-question-tools.ts";

function change(
  local: LocalService,
  action: () => PersonalTodo,
  actor: { botId?: string; runId?: string },
  reason: string,
) {
  const todo = transaction(local.deps.db, () => {
    const result = action();
    const botId = actor.botId ?? result.sourceBotId ?? new BotsRepo(local.deps.db).getMain()?.id;
    if (!botId) throw new RpcError(-32602, "personal_todo_owner_unavailable");
    local.approvals.audit.append({
      botId,
      runId: actor.runId,
      kind: "personal_todo.changed",
      summary: "Personal todo changed / 个人待办已更新",
      detail: { target: result.id, reasonCode: reason, actor: actor.runId ? "automatic" : "user" },
    });
    return result;
  });
  local.deps.peer.emit("inbox.changed", {});
  return todo;
}
/**
 * Latest change wins for a phone's replayed offline edit: a row changed after the edit was made
 * keeps that newer change. Checked inside the write transaction, so no change slips in between.
 */
function unchanged(repo: PersonalTodosRepo, id: string, since: string | undefined) {
  const todo = repo.get(id);
  if (!todo) throw new RpcError(RpcErrorCodes.invalidParams, "personal_todo_unavailable");
  if (since && Date.parse(todo.updatedAt) > Date.parse(since))
    throw new RpcError(RpcErrorCodes.invalidParams, "personal_todo_changed");
  return todo;
}
export function executePersonalTodo(
  local: LocalService,
  context: ToolRunContext,
  call: LocalToolCall,
): LocalToolResult {
  context.signal.throwIfAborted();
  if (!canAskUser(context) || !context.conversationId)
    throw new RpcError(-32602, "personal_todo_unavailable");
  // This resolves the live Bot/group/topic, including membership and archive boundaries.
  const settings = local.execution.get({
    botId: context.botId,
    conversationId: context.conversationId,
  });
  // The tool schema, not the action union: call.input is the model's raw arguments, which may carry
  // other actions' fields that the tool schema drops (848e57b74).
  const input = PersonalTodoToolSchema.parse(call.input);
  const repo = new PersonalTodosRepo(local.deps.db);
  if (input.action !== "list" && settings.mode === "plan")
    throw new RpcError(-32602, "personal_todo_readonly");
  const result =
    input.action === "list"
      ? repo.list(input)
      : change(
          local,
          () => {
            if (input.action === "create")
              return repo.create(
                {
                  title: local.deps.redactor.redact(input.title),
                  dueAt: input.dueAt ?? null,
                  color:
                    input.color ??
                    personalTodoBotColor(
                      new BotsRepo(local.deps.db).get(context.botId)?.avatarColor ?? "",
                    ),
                  sticker: input.sticker,
                  endAt: input.endAt,
                  sourceBotId: context.botId,
                  sourceConversationId: context.conversationId ?? null,
                },
                // A source key makes re-syncing the same calendar / mail item idempotent
                // (maintainers 2026-11-16: a second Feishu sync would otherwise duplicate every entry).
                input.sourceKey ? `source:${input.sourceKey}` : `${context.runId}:${call.id}`,
              );
            if (!repo.get(input.id)) throw new RpcError(-32602, "personal_todo_unavailable");
            return repo.setStatus(input.id, input.action === "complete" ? "done" : "open");
          },
          context,
          input.action,
        );
  return {
    text: JSON.stringify(
      redactValue({ scope: "pibot_personal_todos", result }, local.deps.redactor),
    ),
  };
}
export function registerPersonalTodoRpc(handle: KernelRegisterRpc, local: LocalService) {
  const repo = new PersonalTodosRepo(local.deps.db);
  handle("personalTodos.create", async ({ requestId, title, dueAt, color, sticker, endAt }) =>
    change(
      local,
      () =>
        repo.create(
          {
            title: local.deps.redactor.redact(title),
            dueAt,
            color: color ?? "apricot",
            sticker,
            endAt,
            sourceBotId: null,
            sourceConversationId: null,
          },
          `user:${requestId}`,
        ),
      {},
      "create",
    ),
  );
  handle("personalTodos.update", async ({ id, title, dueAt, unchangedSince, ...decorations }) => {
    if (!repo.get(id)) throw new RpcError(-32602, "personal_todo_unavailable");
    return change(
      local,
      () => {
        unchanged(repo, id, unchangedSince);
        return repo.update(id, { title: local.deps.redactor.redact(title), dueAt, ...decorations });
      },
      {},
      "update",
    );
  });
  handle("personalTodos.delete", async ({ id, unchangedSince }) => {
    if (!repo.get(id)) return null;
    change(
      local,
      () => {
        const todo = unchanged(repo, id, unchangedSince);
        repo.remove(id);
        return todo;
      },
      {},
      "delete",
    );
    return null;
  });
  handle("personalTodos.list", async (input) => repo.listWithOrigin(input));
  handle("personalTodos.undatedCount", async () => repo.undatedCount());
  handle("personalTodos.counts", async () => repo.counts());
  handle("personalTodos.setStatus", async ({ id, status, unchangedSince }) => {
    if (!repo.get(id)) throw new RpcError(-32602, "personal_todo_unavailable");
    return change(
      local,
      () => {
        unchanged(repo, id, unchangedSince);
        return repo.setStatus(id, status);
      },
      {},
      status,
    );
  });
}
