import type { BrainCapability, RegisterRpc } from "@pibot/brain/kit";
import { OFFICE_COMPARE_PORT, type OfficeComparePort } from "@pibot/office-contract";
import { RpcError, RpcErrorCodes } from "@pibot/workspaces-contract/full";
import { registerChangesRpc } from "./changes/changes-rpc.ts";
import { ChangesService } from "./changes/changes-service.ts";
import { GitSetup } from "./changes/git-setup.ts";
import { createCommitDrafter } from "./changes/write/changes-draft.ts";
import { GroupMemberWorktrees } from "./groups/group-member-worktrees.ts";
import { registerManagedResourceRpc } from "./managed/managed-resource-rpc.ts";
import { createManagedResources } from "./managed/managed-resources.ts";
/** Management stops admitting work before the kernel drains; evidence survives until actual run drain. */
export function workspacesCapability(): BrainCapability {
  return {
    id: "workspaces",
    async register(ctx) {
      let closed = false;
      const pending = new Set<Promise<unknown>>();
      const changes = new ChangesService(ctx.workspaces.host.local);
      const gitSetup = new GitSetup(ctx.workspaces.host.local);
      // Absent when the office capability is not installed; the panel then stays binary.
      changes.office = ctx.ports.get<OfficeComparePort>(OFFICE_COMPARE_PORT);
      let members: GroupMemberWorktrees;
      try {
        members = new GroupMemberWorktrees(ctx.workspaces.host.groups);
      } catch (error) {
        await changes.dispose();
        throw error;
      }
      let resources: ReturnType<typeof createManagedResources> | undefined;
      let disposed: Promise<void> | undefined;
      try {
        ctx.workspaces.provide({
          changes,
          members,
          get resources() {
            if (!resources) throw new Error("Workspace registration incomplete");
            return resources;
          },
          quiesce() {
            closed = true;
            resources?.quiesce();
            changes.quiesce();
          },
          dispose() {
            disposed ??= (async () => {
              closed = true;
              resources?.quiesce();
              changes.quiesce();
              await Promise.allSettled([...pending]);
              const settled = await Promise.allSettled([
                gitSetup.dispose(),
                resources?.dispose(),
                members.dispose(),
                changes.dispose(),
              ]);
              const failed = settled.find((result) => result.status === "rejected");
              if (failed?.status === "rejected") throw failed.reason;
            })();
            return disposed;
          },
        });
      } catch (error) {
        await Promise.allSettled([members.dispose(), changes.dispose()]);
        throw error;
      }
      resources = createManagedResources(
        ctx.workspaces.host.local,
        ctx.workspaces.host.chat,
        ctx.workspaces.host.groups,
        ctx.workspaces.host.topics,
        members,
      );
      const drafter = createCommitDrafter({
        agent: ctx.agent,
        db: ctx.db,
        redactor: ctx.redactor,
        logger: ctx.logger,
        requireCredentials: ctx.credentials,
      });
      if (drafter) changes.drafter = drafter(changes);
      const handle: RegisterRpc = (method, action) =>
        ctx.rpc.handle(method, (params, context) => {
          if (closed) throw new RpcError(RpcErrorCodes.closed, "workspaces_stopping");
          const operation = Promise.resolve().then(() => action(params, context));
          pending.add(operation);
          void operation.then(
            () => pending.delete(operation),
            () => pending.delete(operation),
          );
          return operation;
        });
      registerChangesRpc(handle, changes);
      handle("changes.gitStatus", (_params, { signal }) =>
        gitSetup.status(AbortSignal.any([signal, changes.signal(15_000)])),
      );
      handle("changes.gitInstall", (_params, { signal }) =>
        gitSetup.install(AbortSignal.any([signal, changes.signal(15_000)])),
      );
      registerManagedResourceRpc(handle, resources);
      return {
        stop: async () => {
          closed = true;
          resources?.quiesce();
          changes.quiesce();
        },
      };
    },
  };
}
