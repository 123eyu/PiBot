import type { CapabilityContext, RegisterRpc } from "@pibot/brain/kit";
import { redactValue } from "@pibot/brain/kit";
import { RpcError, RpcErrorCodes } from "@pibot/browser-contract/full";
import { AuditRepo, ConversationsRepo, ReadMessagesRepo } from "@pibot/storage";

/** User reads are scoped to the pane's conversation; they never change a run's browser rules. */
export function registerBrowserDebugRpc(handle: RegisterRpc, ctx: CapabilityContext) {
  const scope = (botId: string, conversationId: string, groupId?: string) => {
    const c = new ConversationsRepo(ctx.db).get(conversationId);
    if (
      !c ||
      (c.groupId ?? undefined) !== groupId ||
      c.archivedAt ||
      !new ReadMessagesRepo(ctx.db).scope(botId, conversationId)
    )
      throw new RpcError(RpcErrorCodes.invalidParams, "browser_debug_scope_invalid");
    const host = ctx.host.browserView;
    if (!host?.debug || !host.inspectPoint)
      throw new RpcError(RpcErrorCodes.unsupported, "browser_debug_unsupported");
    return host;
  };
  const audit = (botId: string, conversationId: string, target: string) =>
    new AuditRepo(ctx.db, ctx.redactor).append({
      botId,
      kind: "exec.finished",
      summary: "Browser inspection / 浏览器检查",
      detail: { actor: "user", toolName: target, target: conversationId },
    });
  handle("browser.debug", async ({ botId, groupId, conversationId, tabId, after, limit }) => {
    const host = scope(botId, conversationId, groupId);
    const result = await host.debug?.({
      botId,
      ...(groupId ? { groupId } : {}),
      tab: tabId,
      after,
      limit,
    });
    if (!result) throw new RpcError(RpcErrorCodes.unsupported, "browser_debug_unsupported");
    scope(botId, conversationId, groupId);
    audit(botId, conversationId, "browser_diagnostics");
    return redactValue(result, ctx.redactor) as typeof result;
  });
  handle("browser.inspectPoint", async ({ botId, groupId, conversationId, tabId, ...point }) => {
    const host = scope(botId, conversationId, groupId);
    const result = await host.inspectPoint?.({
      botId,
      ...(groupId ? { groupId } : {}),
      tab: tabId,
      ...point,
    });
    if (!result) throw new RpcError(RpcErrorCodes.unsupported, "browser_debug_unsupported");
    scope(botId, conversationId, groupId);
    audit(botId, conversationId, "browser_inspect");
    return redactValue(result, ctx.redactor) as typeof result;
  });
}
