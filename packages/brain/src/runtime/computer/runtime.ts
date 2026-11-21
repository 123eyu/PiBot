import { matchesRoutinePreauth } from "@pibot/policy";
import { HostComputerMethods, type HostComputerResults, RpcError } from "@pibot/protocol-base";
import { AppBlocklistRepo, BotsRepo, SettingsRepo } from "@pibot/storage";
import type { HostCall } from "../../core/host-call.ts";
import {
  explainRunScope,
  runPermissionScope,
  runPermissionSources,
  runPermissions,
} from "../../core/run-permissions.ts";
import { runYolo } from "../../core/yolo.ts";
import type { LocalService } from "../../local-service.ts";
import { observeDelivery } from "../review/delivery-observer.ts";
import { connectedLocalAppRestriction } from "./connection-preference.ts";
import type { ComputerRunContext, ComputerRuntime } from "./port.ts";

/** The capability sees computer data; trusted runtime identity is re-read for every engine action. */
export function computerRuntime(
  local: LocalService,
  abortRun: (id: string) => Promise<void>,
): ComputerRuntime {
  const context = (value: ComputerRunContext) => {
    const current = local.drainedContext(value.runId);
    if (!current || current.botId !== value.botId || current.messageId !== value.messageId)
      throw new RpcError(-32602, "computer_run_changed");
    return current;
  };
  const hosts = new Map<string, HostCall<typeof HostComputerMethods>>();
  return {
    computerHost(value) {
      const cached = hosts.get(value.runId);
      if (cached) return cached;
      const current = context(value);
      const location = current.runWorkplace?.boundary.location;
      if (!location?.target.startsWith("runner:")) {
        const direct = local.deps.host.computer;
        if (!direct) return undefined;
        const localHost: HostCall<typeof HostComputerMethods> = {
          call(method, input, signal) {
            if (
              method !== "host.computer.grants.revoke" &&
              context(value).runWorkplace?.boundary.location?.target.startsWith("runner:")
            )
              throw new RpcError(-32602, "computer_target_changed");
            return direct.call(method, input, signal);
          },
        };
        hosts.set(value.runId, localHost);
        return localHost;
      }
      const entry = local.executionTargets.require(location.target);
      const computer = entry.target.computer;
      if (!computer) return undefined;
      const host: HostCall<typeof HostComputerMethods> = {
        call(method, input, signal) {
          const cleanup = method === "host.computer.grants.revoke";
          const blockedApps = new AppBlocklistRepo(local.deps.db)
            .list()
            .map((entry) => entry.appId);
          const check = () => {
            signal.throwIfAborted();
            if (local.executionTargets.require(location.target) !== entry)
              throw new RpcError(-32602, "computer_target_changed");
            if (!cleanup) {
              const active = context(value);
              if (active.runWorkplace?.boundary.location?.target !== location.target)
                throw new RpcError(-32602, "computer_target_changed");
              local.endpoints?.check("screenshot", active);
              if (
                JSON.stringify(
                  new AppBlocklistRepo(local.deps.db).list().map((entry) => entry.appId),
                ) !== JSON.stringify(blockedApps)
              )
                throw new RpcError(-32602, "computer_blocklist_changed");
            }
          };
          check();
          return computer
            .call(method, input, signal, check, blockedApps)
            .then(
              (result) =>
                HostComputerMethods[method].result.parse(
                  result,
                ) as HostComputerResults[typeof method],
            );
        },
      };
      hosts.set(value.runId, host);
      return host;
    },
    releaseComputerHost: (runId) => {
      hosts.delete(runId);
    },
    deps: {
      db: local.deps.db,
      dataDir: local.deps.dataDir,
      host: local.deps.host,
      redactor: local.deps.redactor,
      logger: local.deps.logger,
      peer: local.deps.peer,
      platform: local.deps.platform,
    },
    shutdown: local.shutdown,
    approvals: {
      audit: local.approvals.audit,
      pauseExpiredChat: (id) => local.approvals.pauseExpiredChat(id),
      grants: local.approvals.grants,
      resolve: (...args) => local.approvals.resolve(...args),
      request: (value, ...args) =>
        local.approvals.request({ ...context(value), signal: value.signal }, ...args),
    },
    connectionRestriction(value, tool, apps) {
      const current = context(value);
      for (const app of apps) {
        const reason = connectedLocalAppRestriction(local, current, tool, app);
        if (reason) return reason;
      }
    },
    permissionScope: (value) => runPermissionScope(local, context(value)),
    isYolo: (value) => runYolo(local, context(value)),
    grants: (botId, value) => local.grants(botId, context(value)),
    async evaluate(value, call, signal) {
      const current = context(value);
      const policy = await local.getPolicy(signal);
      return explainRunScope(
        local,
        current,
        await policy.evaluate({
          botId: current.botId,
          request: {
            category: "computer",
            tool: call.tool,
            apps: call.apps,
            coordinates: call.coordinates,
            alwaysApps: call.always.map((app) => app.id),
          },
          settings: local.tasks.settings(current, runPermissions(local, current)),
          permissionSources: runPermissionSources(local, current),
          workplace: local.workplaces.repo.list(current.botId),
          yolo: runYolo(local, current),
          signal,
        }),
      );
    },
    preauthorized(value, ids, coordinates) {
      const current = context(value);
      if (!current.routineRunId || coordinates || !ids.length) return false;
      const record = local.unattendedAuthorization.record(current);
      if (!record?.routineId || record.reason === "trial") return false;
      const routine = local.unattended?.definition(record.routineId);
      if (!routine || routine.deletedAt || routine.botId !== record.botId) return false;
      const preauth = routine.preauth.find(
        (p) =>
          !p.revokedAt &&
          matchesRoutinePreauth(
            p.operation,
            { category: "computer", scope: { kind: "apps", apps: ids } },
            local.deps.platform,
          ),
      );
      if (!preauth) return false;
      local.unattendedAuthorization.audit(current, "routine.preauth.allowed", {
        preauthId: preauth.id,
        reasonCode: "routine_preauth",
        policySteps: ["routine_preauth"],
      });
      return true;
    },
    source: (value) => (value.executionTaskId ? local.tasks.source(context(value)) : value),
    onYoloEnabled: (id, listener) => local.yolo.onEnabled(id, listener),
    async permissionsChanged(groupId) {
      local.deps.peer.emit("permissions.changed", await local.permissions.get(undefined, groupId));
    },
    observeStep(value, step) {
      const current = context(value);
      observeDelivery(local, current, () => local.evidence.observeStep(current, step));
    },
    abortRun,
    providerName(botId) {
      const provider =
        new BotsRepo(local.deps.db).get(botId)?.modelProvider ??
        new SettingsRepo(local.deps.db).get().defaultModel?.provider;
      return provider ? (local.models?.providerName(provider) ?? null) : null;
    },
  };
}
