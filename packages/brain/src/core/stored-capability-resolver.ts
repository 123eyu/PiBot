import type { DatabaseSync } from "node:sqlite";
import {
  CAPABILITIES,
  type CapabilityAvailable,
  type CapabilityId,
  type CapabilityImpl,
  type CapabilityItem,
  type CapabilityListParams,
  type CapabilitySetParams,
  type CapabilitySource,
  RpcError,
  RpcErrorCodes,
} from "@pibot/protocol-base";
import { BotsRepo, CapabilitySelectionRepo, GroupsRepo } from "@pibot/storage";
import type { ConnectorsPort } from "../runtime/tools/connectors/port.ts";
import type { CapabilityResolver } from "./capability-resolver.ts";
import type { PermissionService } from "./permissions.ts";

const reasons = {
  permission: "权限设置为“从不” / Permission is set to Never",
  missing: "连接不存在 / Connector not found",
  disabled: "连接已关闭 / Connector is disabled",
  offline: "连接未就绪 / Connector is not ready",
  noBuiltin: "没有内置实现 / No built-in implementation",
} as const;

type Selection = { impl: CapabilityImpl; source: CapabilitySource };
type ConnectorState = { ready: true } | { ready: false; reason: string };

export class StoredCapabilityResolver implements CapabilityResolver {
  readonly repo: CapabilitySelectionRepo;

  constructor(
    private readonly deps: {
      db: DatabaseSync;
      defaults: CapabilityResolver;
      permissions: PermissionService;
      connectors: () => ConnectorsPort | undefined;
    },
  ) {
    this.repo = new CapabilitySelectionRepo(deps.db);
  }

  resolve(scope: { botId: string; groupId?: string }): ReadonlyMap<CapabilityId, CapabilityImpl> {
    return new Map(this.items(scope).map((item) => [item.id, item.impl]));
  }

  list(params: CapabilityListParams): { items: CapabilityItem[] } {
    this.assertListScope(params);
    return { items: this.items(params) };
  }

  validateSet(params: CapabilitySetParams): void {
    this.assertSetScope(params);
    if (params.impl === "builtin") {
      const capability = CAPABILITIES.find((item) => item.id === params.capabilityId);
      if (!capability?.hasBuiltin)
        throw new RpcError(RpcErrorCodes.invalidParams, "capability_builtin_unavailable");
    }
    if (params.impl?.startsWith("connector:")) {
      if (params.capabilityId === "files.write")
        throw new RpcError(RpcErrorCodes.invalidParams, "capability_connector_write_unsupported");
      const connectorId = params.impl.slice("connector:".length);
      const connectors = this.deps.connectors();
      if (!connectors?.get(connectorId))
        throw new RpcError(RpcErrorCodes.connectorUnavailable, "connector_unavailable");
      // Only the trusted mapping of the current catalog counts, never names or descriptions.
      if (!connectors.capabilitySuggestions(connectorId).includes(params.capabilityId))
        throw new RpcError(RpcErrorCodes.invalidParams, "capability_connector_unmapped");
    }
  }

  write(params: CapabilitySetParams): void {
    const scopeId = params.scope === "global" ? "" : (params.scopeId as string);
    if (params.impl === null) this.repo.clear(params.scope, scopeId, params.capabilityId);
    else this.repo.set(params.scope, scopeId, params.capabilityId, params.impl);
  }

  private items(params: CapabilityListParams): CapabilityItem[] {
    const defaults = new Map(
      this.deps.defaults.resolve({
        botId: params.botId ?? "",
        ...(params.groupId ? { groupId: params.groupId } : {}),
      }),
    );
    // A capability without a built-in implementation (calendar, contacts) defaults to the
    // connection this Bot can already use, so nothing that worked before capability mapping
    // disappears until the user chooses otherwise. The global view has no Bot, so it shows the
    // first enabled
    // connection mapping the capability — what a Bot with access to it gets.
    const candidates = this.connectorCandidates(params.botId);
    const connected = params.botId
      ? this.connectedDefaults(params.botId)
      : new Map([...candidates].flatMap(([id, ids]) => (ids[0] ? [[id, ids[0]] as const] : [])));
    for (const [capabilityId, connectorId] of connected)
      if ((defaults.get(capabilityId) ?? "off") === "off")
        defaults.set(capabilityId, `connector:${connectorId}` as CapabilityImpl);
    const global = new Map(
      this.repo.list("global", "").map((row) => [row.capabilityId, row.impl] as const),
    );
    const group = params.groupId
      ? new Map(
          this.repo
            .list("group", params.groupId)
            .map((row) => [row.capabilityId, row.impl] as const),
        )
      : undefined;
    const bot = params.botId
      ? new Map(
          this.repo.list("bot", params.botId).map((row) => [row.capabilityId, row.impl] as const),
        )
      : undefined;
    const levels = this.permissionLevels(params);

    return CAPABILITIES.map((capability) => {
      const selected = this.selection(capability.id, defaults, global, group, bot);
      const permissionDenied = levels[capability.permissionCategory] === "never";
      const available = this.available(
        capability,
        selected.impl,
        defaults.get(capability.id),
        candidates.get(capability.id) ?? [],
      );
      if (permissionDenied) {
        for (const option of available) {
          if (option.impl !== "off") {
            option.ready = false;
            option.reason = reasons.permission;
          }
        }
        return { id: capability.id, impl: "off", source: selected.source, available };
      }

      if (this.implReady(capability, selected.impl).ready)
        return { id: capability.id, impl: selected.impl, source: selected.source, available };

      const fallback = defaults.get(capability.id) ?? "off";
      const impl = this.implReady(capability, fallback).ready ? fallback : "off";
      return { id: capability.id, impl, source: "default", available };
    });
  }

  private selection(
    id: CapabilityId,
    defaults: ReadonlyMap<CapabilityId, CapabilityImpl>,
    global: ReadonlyMap<CapabilityId, CapabilityImpl>,
    group?: ReadonlyMap<CapabilityId, CapabilityImpl>,
    bot?: ReadonlyMap<CapabilityId, CapabilityImpl>,
  ): Selection {
    const botImpl = bot?.get(id);
    if (botImpl !== undefined) return { impl: botImpl, source: "bot" };
    const groupImpl = group?.get(id);
    if (groupImpl !== undefined) return { impl: groupImpl, source: "group" };
    const globalImpl = global.get(id);
    if (globalImpl !== undefined) return { impl: globalImpl, source: "global" };
    return { impl: defaults.get(id) ?? "off", source: "default" };
  }

  /**
   * Every connection that can implement each capability, so any of them can be chosen; for a
   * Bot, only the ones it may use ("ask first" still counts: the Bot asks on first use).
   */
  private connectorCandidates(botId?: string): Map<CapabilityId, readonly string[]> {
    const connectors = this.deps.connectors();
    const usable = (id: string) => {
      if (!botId) return true;
      const access = connectors?.access(id);
      return access?.mode !== "selected" || access.bots.includes(botId);
    };
    return new Map(
      CAPABILITIES.map((c) => [
        c.id,
        connectors ? connectors.capabilityConnectors(c.id).filter(usable) : [],
      ]),
    );
  }

  /**
   * Per mapped capability, use Pi Bot's own trusted native app first, otherwise the first in
   * discovery order. One connection per capability keeps the model from seeing duplicate
   * implementations.
   */
  private connectedDefaults(botId: string): Map<CapabilityId, string> {
    const connectors = this.deps.connectors();
    const found = new Map<CapabilityId, string>();
    if (!connectors) return found;
    const wanted = new Set<CapabilityId>(
      CAPABILITIES.filter((c) => !c.hasBuiltin).map((c) => c.id),
    );
    const native = new Set<CapabilityId>();
    let cursor: string | undefined;
    // Bounded like the app index: 40 pages of 50 tools.
    for (let page = 0; page < 40 && native.size < wanted.size; page++) {
      const result = connectors.discoverToolsForBot(botId, {
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      for (const tool of result.items) {
        const id = tool.capabilityId;
        if (!id || !wanted.has(id) || native.has(id)) continue;
        if (connectors.get(tool.connectorId)?.kind === "builtin") {
          native.add(id);
          found.set(id, tool.connectorId);
        } else if (!found.has(id)) found.set(id, tool.connectorId);
      }
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return found;
  }

  private available(
    capability: (typeof CAPABILITIES)[number],
    selected: CapabilityImpl,
    fallback: CapabilityImpl | undefined,
    connectorIds: readonly string[],
  ): CapabilityAvailable[] {
    const candidates: CapabilityImpl[] = [
      ...(capability.hasBuiltin ? (["builtin"] as const) : []),
      ...(selected.startsWith("connector:") ? [selected] : []),
      ...(fallback?.startsWith("connector:") ? [fallback] : []),
      // files.write has no connector implementation (validateSet refuses it).
      ...(capability.id === "files.write"
        ? []
        : connectorIds.map((id) => `connector:${id}` as CapabilityImpl)),
      "off",
    ];
    return [...new Set(candidates)].map((impl) => ({ impl, ...this.implReady(capability, impl) }));
  }

  private implReady(
    capability: (typeof CAPABILITIES)[number],
    impl: CapabilityImpl,
  ): { ready: boolean; reason?: string } {
    if (impl === "off") return { ready: true };
    if (impl === "builtin")
      return capability.hasBuiltin ? { ready: true } : { ready: false, reason: reasons.noBuiltin };
    return this.connectorState(impl.slice("connector:".length));
  }

  private connectorState(id: string): ConnectorState {
    const connector = this.deps.connectors()?.get(id);
    if (!connector) return { ready: false, reason: reasons.missing };
    if (!connector.enabled) return { ready: false, reason: reasons.disabled };
    if (connector.status !== "ready" && connector.status !== "idle")
      return { ready: false, reason: reasons.offline };
    return { ready: true };
  }

  private permissionLevels(params: CapabilityListParams) {
    if (params.groupId) return this.deps.permissions.effectiveGroup(params.groupId).levels;
    if (params.botId) return this.deps.permissions.effective(params.botId).levels;
    return this.deps.permissions.repo.get().levels;
  }

  private assertListScope(params: CapabilityListParams): void {
    const bot = params.botId ? new BotsRepo(this.deps.db).get(params.botId) : undefined;
    const group = params.groupId ? new GroupsRepo(this.deps.db).get(params.groupId) : undefined;
    if (params.botId && (!bot || bot.archivedAt))
      throw new RpcError(RpcErrorCodes.invalidParams, "capability_bot_unavailable");
    if (params.groupId && !group)
      throw new RpcError(RpcErrorCodes.invalidParams, "capability_group_unavailable");
    if (bot && group && !group.members.some((member) => member.botId === bot.id))
      throw new RpcError(RpcErrorCodes.invalidParams, "capability_scope_mismatch");
  }

  private assertSetScope(params: CapabilitySetParams): void {
    if (params.scope === "global") return;
    if (params.scope === "bot") {
      const bot = new BotsRepo(this.deps.db).get(params.scopeId as string);
      if (!bot || bot.archivedAt)
        throw new RpcError(RpcErrorCodes.invalidParams, "capability_bot_unavailable");
      return;
    }
    if (!new GroupsRepo(this.deps.db).get(params.scopeId as string))
      throw new RpcError(RpcErrorCodes.invalidParams, "capability_group_unavailable");
  }
}
