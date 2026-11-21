import type { RegisterRpc } from "@pibot/brain/kit";
import {
  type ComputerPermissions,
  type ComputerStatus,
  RpcError,
  RpcErrorCodes,
} from "@pibot/computer-use-contract/full";
import {
  AppBlocklistRepo,
  BotComputerAlwaysRepo,
  BotsRepo,
  ComputerGrantsRepo,
  ComputerSettingsRepo,
  GroupComputerAlwaysRepo,
  GroupsRepo,
  transaction,
} from "@pibot/storage";
import type { ComputerContext } from "../../context.ts";

const HOST_TIMEOUT_MS = 15_000;

function permissions(
  platform: ComputerPermissions["platform"],
  status: ComputerStatus | undefined,
): ComputerPermissions {
  if (!status)
    return { platform, available: false, unavailableReason: "driver_missing", items: [] };
  const map = (value: ComputerStatus["permissions"]["accessibility"]) =>
    value === "ask_per_app" ? "unknown" : value === "not_needed" ? "not_required" : value;
  const reason = status.unavailableReason?.toLowerCase() ?? "";
  return {
    platform: status.platform,
    available: status.available,
    unavailableReason: status.available
      ? null
      : reason === "permission_missing"
        ? "permission_missing"
        : reason.includes("session")
          ? "non_interactive_session"
          : reason.includes("wayland")
            ? "wayland_limited"
            : reason.includes("unsupported")
              ? "unsupported_platform"
              : "driver_missing",
    items: [
      { kind: "accessibility", status: map(status.permissions.accessibility) },
      { kind: "screen", status: map(status.permissions.screenRecording) },
      { kind: "automation", status: map(status.permissions.automation) },
    ],
  };
}

/**
 * Business methods for operating the computer, registered through brain's single RPC
 * wrapper (validation, redacted logging, error mapping). Steps and screenshots belong to the tool
 * execution.
 */
export function registerComputerRpc(handle: RegisterRpc, local: ComputerContext) {
  const { db } = local.deps;
  const gate = local.computerGrants;
  const host = () => {
    const value = local.deps.host.computer;
    if (!value) throw new RpcError(RpcErrorCodes.unsupported, "computer_unsupported");
    return value;
  };
  const signal = () =>
    AbortSignal.any([local.shutdown.signal, AbortSignal.timeout(HOST_TIMEOUT_MS)]);
  const requireBot = (botId: string) => {
    const bot = new BotsRepo(db).get(botId);
    if (!bot || bot.archivedAt) throw new RpcError(-32602, "Unknown active Bot");
    return bot;
  };
  const audit = (
    botId: string,
    kind: "grant.created" | "grant.revoked",
    programs: string[],
    groupId?: string,
  ) =>
    local.approvals.audit.append({
      botId,
      kind,
      summary:
        kind === "grant.created"
          ? "Computer always-list set / 已设置操作电脑的总是允许清单"
          : "Computer always-list cleared / 已清除操作电脑的总是允许清单",
      detail: {
        category: "computer",
        programs,
        actor: "user",
        reasonCode: "computer_always",
        ...(groupId ? { groupId } : {}),
      },
    });

  handle("computer.grant.resolve", (params) => gate.resolve(params));
  handle("computer.grants", async ({ botId, runId, before, limit }) =>
    new ComputerGrantsRepo(db).list(
      { ...(botId ? { botId } : {}), ...(runId ? { runId } : {}) },
      { ...(before ? { before } : {}), ...(limit ? { limit } : {}) },
    ),
  );
  handle("computer.stop", async ({ botId }) => {
    await gate.stop(botId);
    return { ok: true };
  });
  handle("computer.pause", async ({ botId }) => {
    gate.runs.pause(botId, true);
    return { ok: true };
  });
  handle("computer.resume", async ({ botId }) => {
    gate.runs.pause(botId, false);
    return { ok: true };
  });
  handle("computer.handoff.resolve", async ({ id, action }) => {
    local.computerHandoff.resolve(id, action);
    return { ok: true };
  });
  handle("computer.foreground.resolve", async ({ requestId, allow }) => {
    gate.runs.foregroundResolve(requestId, allow);
    return { ok: true };
  });
  handle("computer.status", async () =>
    [...gate.runs.map.values()].slice(0, 200).map((run) => gate.runs.state(run)),
  );
  handle("computer.permissions", async () => {
    const value = local.deps.host.computer;
    let status: ComputerStatus | undefined;
    try {
      status = value ? await value.call("host.computer.status", {}, signal()) : undefined;
    } catch (error) {
      if (!(error instanceof RpcError) || error.code !== RpcErrorCodes.unsupported) throw error;
    }
    return permissions(local.deps.platform, status);
  });
  handle("computer.openSystemSettings", async ({ pane }) => {
    await host().call(
      "host.computer.openSystemSettings",
      { pane: pane === "screen" ? "screenRecording" : pane },
      signal(),
    );
    return { ok: true };
  });
  handle("computer.installedApps", async () => {
    const result = await host().call("host.computer.installedApps", {}, signal());
    return result.supported
      ? {
          supported: true as const,
          truncated: result.truncated,
          apps: result.apps.map(({ id, name, category }) => ({
            id,
            name,
            ...(category ? { category } : {}),
          })),
        }
      : result;
  });
  handle("computer.always.get", async ({ botId, groupId }) => {
    if (groupId) {
      if (!new GroupsRepo(db).get(groupId)) throw new RpcError(-32602, "Unknown group");
      return new GroupComputerAlwaysRepo(db).get(groupId);
    }
    if (!botId) throw new RpcError(-32602, "Missing permission scope");
    requireBot(botId);
    return new BotComputerAlwaysRepo(db).get(botId);
  });
  handle("computer.always.set", async ({ botId, groupId, apps }) => {
    if (groupId) {
      const group = new GroupsRepo(db).get(groupId);
      if (!group) throw new RpcError(-32602, "Unknown group");
      if (new AppBlocklistRepo(db).blockedAmong(apps.map((app: { id: string }) => app.id)).size)
        throw new RpcError(-32602, "computer_app_blocked");
      const value = transaction(db, () => {
        const saved = new GroupComputerAlwaysRepo(db).set(groupId, apps);
        audit(
          group.coordinatorBotId,
          "grant.created",
          saved.apps.map((app) => app.id),
          groupId,
        );
        return saved;
      });
      await local.permissionsChanged(groupId);
      return value;
    }
    if (!botId) throw new RpcError(-32602, "Missing permission scope");
    requireBot(botId);
    // The repository rejects blocklisted apps in the same transaction.
    if (new AppBlocklistRepo(db).blockedAmong(apps.map((app: { id: string }) => app.id)).size)
      throw new RpcError(-32602, "computer_app_blocked");
    const value = new BotComputerAlwaysRepo(db).set(botId, apps);
    audit(
      botId,
      "grant.created",
      value.apps.map((app) => app.id),
    );
    return value;
  });
  handle("computer.always.clear", async ({ botId, groupId }) => {
    if (groupId) {
      const group = new GroupsRepo(db).get(groupId);
      if (!group) throw new RpcError(-32602, "Unknown group");
      const repo = new GroupComputerAlwaysRepo(db);
      transaction(db, () => {
        const previous = repo.get(groupId);
        if (repo.clear(groupId))
          audit(
            group.coordinatorBotId,
            "grant.revoked",
            previous?.apps.map((app) => app.id) ?? [],
            groupId,
          );
      });
      await local.permissionsChanged(groupId);
      return { ok: true as const };
    }
    if (!botId) throw new RpcError(-32602, "Missing permission scope");
    requireBot(botId);
    const repo = new BotComputerAlwaysRepo(db);
    const previous = repo.get(botId);
    if (repo.clear(botId) && previous)
      audit(
        botId,
        "grant.revoked",
        previous.apps.map((app) => app.id),
      );
    return { ok: true };
  });
  handle("computer.blocklist.list", async () => new AppBlocklistRepo(db).listWithRemoved());
  handle("computer.blocklist.add", async ({ app }) => {
    let entry: ReturnType<AppBlocklistRepo["add"]>;
    try {
      entry = new AppBlocklistRepo(db).add(app);
    } catch (error) {
      if (error instanceof TypeError) throw new RpcError(-32602, "computer_app_unblockable");
      throw error;
    }
    local.deps.logger.info("computer blocklist changed action=add");
    await gate.mirrorBlocklist();
    return entry;
  });
  handle("computer.blocklist.remove", async ({ appId }) => {
    if (!new AppBlocklistRepo(db).remove(appId))
      throw new RpcError(-32602, "computer_app_not_removable");
    local.deps.logger.info("computer blocklist changed action=remove");
    await gate.mirrorBlocklist();
    return { ok: true };
  });
  handle("computer.settings.get", async () => new ComputerSettingsRepo(db).get());
  handle("computer.settings.set", async (params) => new ComputerSettingsRepo(db).set(params));
}
