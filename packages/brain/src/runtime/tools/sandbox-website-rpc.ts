import { RpcError } from "@pibot/protocol-base";
import { BotsRepo, ChatNoticesRepo, ConversationsRepo, GroupsRepo, RunsRepo } from "@pibot/storage";
import type { KernelRegisterRpc } from "../../core/business-rpc.ts";
import type { LocalService } from "../../local-service.ts";
import { isWebsitePermissionDomain } from "./policy-website-notices.ts";

export function registerSandboxWebsiteRpc(
  handle: KernelRegisterRpc,
  local: LocalService,
  save: LocalService["permissions"]["set"],
) {
  handle("permissions.allowBlockedWebsite", async ({ noticeId, scope }, { source, signal }) => {
    signal.throwIfAborted();
    if (source === "acp") throw new RpcError(-32602, "website_permission_requires_user");
    const { db } = local.deps;
    // A hostname supplied by a caller, model or command output cannot become permission evidence.
    const notice = new ChatNoticesRepo(db).get(noticeId);
    if (notice?.kind !== "agent_warning" || !notice.sandbox?.website)
      throw new RpcError(-32602, "website_permission_unavailable");
    const { domain, groupId } = notice.sandbox.website;
    const bot = new BotsRepo(db).get(notice.botId);
    const run = new RunsRepo(db).get(notice.runId);
    const conversation = new ConversationsRepo(db).get(notice.conversationId);
    if (
      notice.sandbox.kind !== "network" ||
      !["proxy_denied", "domain_not_allowed"].includes(notice.sandbox.rule) ||
      !notice.sandbox.toolCallId ||
      !isWebsitePermissionDomain(domain) ||
      !bot ||
      bot.archivedAt ||
      !run ||
      run.botId !== bot.id ||
      run.conversationId !== notice.conversationId ||
      !conversation ||
      conversation.archivedAt ||
      (!groupId && (conversation.groupId || conversation.botId !== bot.id)) ||
      (scope !== "global" && scope !== (groupId ? "group" : "bot"))
    )
      throw new RpcError(-32602, "website_permission_scope_changed");
    if (groupId) {
      const group = new GroupsRepo(db).get(groupId);
      if (!group || group.archivedAt || !group.members.some((member) => member.botId === bot.id))
        throw new RpcError(-32602, "website_permission_scope_changed");
    }
    const owner = scope === "global" ? {} : groupId ? { groupId } : { botId: bot.id };
    const network = owner.groupId
      ? local.permissions.effectiveGroup(owner.groupId).network
      : owner.botId
        ? local.permissions.effective(owner.botId).network
        : local.permissions.repo.get().network;
    if (network.domains.includes(domain)) return local.permissions.get(owner.botId, owner.groupId);
    const domains = [...network.domains, domain];
    if (domains.length > 200) throw new RpcError(-32602, "website_permission_list_full");
    // No await between reading and saving: concurrent clicks cannot lose each other's domains.
    // The shared service handles validation, scoped writes, audit and permissions.changed.
    return save({ ...owner, network: { domains } });
  });
}
