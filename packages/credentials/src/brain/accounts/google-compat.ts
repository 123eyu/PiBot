import { auditText } from "@pibot/brain/kit";
import {
  type BotGoogleCompat,
  type GoogleCompatScope,
  RpcError,
  type ScopedGoogleCompat,
} from "@pibot/credentials-contract/full";
import { BotsRepo, GroupsRepo, transaction } from "@pibot/storage";
import { BotGoogleCompatRepo, GroupGoogleCompatRepo } from "../../store/index.ts";
import type { CredentialContext } from "../context.ts";

/** User-controlled browser identity settings keep direct-chat and group profiles independent. */
export class GoogleCompatService {
  private readonly repo: BotGoogleCompatRepo;
  private readonly groups: GroupGoogleCompatRepo;
  constructor(private readonly local: CredentialContext) {
    this.repo = new BotGoogleCompatRepo(local.deps.db);
    this.groups = new GroupGoogleCompatRepo(local.deps.db);
  }
  enabled(scope: GoogleCompatScope): boolean {
    return scope.groupId
      ? this.groups.enabled(scope.groupId)
      : this.repo.enabled(scope.botId as string);
  }
  get(botId: string): BotGoogleCompat;
  get(scope: GoogleCompatScope): ScopedGoogleCompat;
  get(input: string | GoogleCompatScope): ScopedGoogleCompat {
    const scope = typeof input === "string" ? { botId: input } : input;
    if (!scope.groupId && !scope.botId)
      throw new RpcError(-32602, "Missing browser settings scope");
    const state = scope.groupId
      ? this.groups.get(scope.groupId)
      : this.repo.get(scope.botId as string);
    if (!state) throw new RpcError(-32602, scope.groupId ? "group_not_found" : "bot_not_found");
    return state;
  }
  set(botId: string, enabled: boolean): Promise<BotGoogleCompat>;
  set(scope: GoogleCompatScope, enabled: boolean): Promise<ScopedGoogleCompat>;
  async set(input: string | GoogleCompatScope, enabled: boolean): Promise<ScopedGoogleCompat> {
    const scope = typeof input === "string" ? { botId: input } : input;
    const before = this.get(scope);
    if (before.enabled === enabled) return before;
    const { db, redactor } = this.local.deps;
    const group = scope.groupId ? new GroupsRepo(db).get(scope.groupId) : undefined;
    if (scope.groupId && !group) throw new RpcError(-32602, "group_not_found");
    const botId = group?.coordinatorBotId ?? scope.botId;
    if (!botId) throw new RpcError(-32602, "bot_not_found");
    const state = transaction(db, () => {
      const value = scope.groupId
        ? this.groups.set(scope.groupId, enabled)
        : this.repo.set(botId, enabled);
      if (!value) throw new RpcError(-32602, scope.groupId ? "group_not_found" : "bot_not_found");
      this.local.approvals.audit.append({
        botId,
        kind: "browser.google_compat",
        summary: enabled
          ? "Google compatibility mode on / 已开启 Google 兼容模式"
          : "Google compatibility mode off / 已关闭 Google 兼容模式",
        detail: {
          actor: "user",
          reasonCode: enabled ? "google_compat_on" : "google_compat_off",
          botName: auditText(new BotsRepo(db).get(botId)?.name ?? "Bot", redactor),
          ...(scope.groupId
            ? { groupId: scope.groupId, groupName: auditText(group?.name ?? "Group", redactor) }
            : {}),
        },
      });
      return value;
    });
    this.local.deps.peer.emit("browser.googleCompat.changed", state);
    const signal = AbortSignal.any([this.local.shutdown.signal, AbortSignal.timeout(15000)]);
    try {
      if (scope.groupId) await this.local.browser.refreshGroupGoogleCompat(scope.groupId, signal);
      else await this.local.browser.refreshGoogleCompat(botId, signal);
    } catch {
      // Persistence succeeded; the next scoped browser operation pushes the saved rules again.
      this.local.deps.logger.warn(
        scope.groupId
          ? `Google compatibility not pushed to group browsers groupId=${scope.groupId}`
          : `Google compatibility not pushed to browser botId=${botId}`,
      );
    }
    return state;
  }
}
