import type {
  ManagedBranchConfigurationHandle,
  ManagedBranchConfigurationPort,
  ManagedConfigOwnerProof,
  WorkspaceLocal,
} from "@pibot/brain/kit";
import {
  ExecError,
  gitConfigurationDigest,
  managedBranchConfigurationIntent,
  prepareRegisteredBranchConfiguration,
  verifyRegisteredBranchConfiguration,
} from "@pibot/execution";
import { BotsRepo, ConversationsRepo } from "@pibot/storage";
import type { ManagedBranchConfigBinding } from "@pibot/workspaces-contract/full";
import type { ManagedResourceLifecycle } from "./managed-resource-lifecycle.ts";
import { managedScopeKey, primaryManagedScope } from "./managed-resource-ports.ts";
import { ManagedServiceLifetime } from "./managed-service-lifetime.ts";
import type { ManagedWorktreeService } from "./managed-worktrees.ts";

/** Registration proves only this bound branch's fixed setter, never a family-wide write root. */
export class ManagedBranchConfigurationService implements ManagedBranchConfigurationPort {
  private readonly lifetime = new ManagedServiceLifetime();
  private readonly stop = new AbortController();
  private readonly handles = new WeakSet<ManagedBranchConfigurationHandle>();
  constructor(
    private readonly local: WorkspaceLocal,
    private readonly trees: ManagedWorktreeService,
    private readonly lifecycle: ManagedResourceLifecycle,
  ) {}

  prepare: ManagedBranchConfigurationPort["prepare"] = (request, signal) =>
    this.lifetime.run(signal, async (signal) => {
      const { context, intent } = request;
      if (
        this.local.deps.platform !== "darwin" ||
        context.executionTaskId ||
        context.routineRunId ||
        context.routineWorkplace ||
        context.routineSource ||
        context.routineResume ||
        !context.conversationId
      )
        return undefined;
      const target = {
        conversationKey: context.groupId ? `group:${context.groupId}` : `dm:${context.botId}`,
        ...(!context.groupId ? { topicId: context.conversationId } : {}),
        rootId: request.primaryRootId,
      };
      const scope = await this.local.changes.scope(target, signal);
      const value = this.trees.repo.byPath(scope.primary.path);
      if (!value) return undefined;
      primaryManagedScope(scope);
      if (
        value.state !== "ready" ||
        this.trees.repo.taskOwned(value.id) ||
        value.botId !== context.botId ||
        scope.botId !== context.botId ||
        scope.conversationId !== context.conversationId ||
        scope.groupId !== context.groupId ||
        scope.root.id !== request.primaryRootId ||
        !value.head ||
        !value.identity ||
        !this.trees.repo.bindings(value.id).includes(managedScopeKey(scope)) ||
        !managedBranchConfigurationIntent(intent, value.branch) ||
        !(await this.trees.managedLayout.allows(scope, signal))
      )
        throw new ExecError("outside_workplace");
      const current = await this.trees.git.inspect(value.path, signal);
      if (current.head !== value.head || current.branch !== `refs/heads/${value.branch}`)
        throw new ExecError("file_conflict");
      const plan = await prepareRegisteredBranchConfiguration(
        {
          source: value.sourceIdentity,
          primary: value.identity.root,
          git: value.identity.git,
          common: value.identity.common,
          branch: value.branch,
          head: value.head,
          intent,
        },
        signal,
      );
      const call = Object.freeze({
        botId: context.botId,
        runId: context.runId,
        toolCallId: request.toolCallId,
        conversationKey: scope.conversationKey,
        topicId: context.conversationId,
        conversationId: context.conversationId,
        ...(context.groupId ? { groupId: context.groupId } : {}),
      });
      const fields = {
        purpose: "af8-own-branch-pushremote" as const,
        call,
        registryId: value.id,
        registryVersion: value.version,
        source: Object.freeze({ ...plan.source }),
        primary: Object.freeze({ ...plan.primary }),
        git: Object.freeze({ ...plan.git }),
        common: Object.freeze({ ...plan.common }),
        branch: value.branch,
        head: value.head,
        cwd: intent.cwd,
        key: intent.key,
        targetPath: plan.config.identity.path,
        intentDigest: intent.digest,
        beforeVersion: plan.beforeVersion,
      };
      const binding: Readonly<ManagedBranchConfigBinding> = Object.freeze({
        ...fields,
        bindingDigest: gitConfigurationDigest(fields),
      });
      const registered = JSON.stringify(value);
      let disposed = false;
      let consumed = false;
      const assertCurrent = (requirement: Readonly<ManagedBranchConfigBinding>) => {
        context.signal.throwIfAborted();
        this.stop.signal.throwIfAborted();
        this.local.shutdown.signal.throwIfAborted();
        const topic = new ConversationsRepo(this.local.deps.db).get(call.conversationId);
        const bot = new BotsRepo(this.local.deps.db).get(call.botId);
        if (
          disposed ||
          !this.handles.has(handle) ||
          requirement.bindingDigest !== binding.bindingDigest ||
          JSON.stringify(requirement) !== JSON.stringify(binding) ||
          !topic ||
          topic.archivedAt ||
          !bot ||
          bot.archivedAt ||
          JSON.stringify(this.trees.repo.get(value.id)) !== registered ||
          this.trees.repo.taskOwned(value.id) ||
          !this.trees.repo.bindings(value.id).includes(managedScopeKey(scope))
        )
          throw new ExecError("authorization_changed");
        verifyRegisteredBranchConfiguration(plan);
      };
      const handle: ManagedBranchConfigurationHandle = Object.freeze({
        binding,
        plan,
        assertCurrent,
        withPublicationLease: <T>(
          owner: ManagedConfigOwnerProof,
          observation: AbortSignal,
          operation: (check: () => void) => Promise<T>,
        ) =>
          this.lifetime.run(observation, async (joined) => {
            assertCurrent(binding);
            if (consumed) throw new ExecError("authorization_changed");
            consumed = true;
            if (JSON.stringify(owner.call) !== JSON.stringify(call))
              throw new ExecError("authorization_changed");
            try {
              return await this.lifecycle.configurationExclusive(
                scope,
                [plan.primary.path, plan.common.path],
                owner,
                joined,
                async (check) => {
                  assertCurrent(binding);
                  return operation(() => {
                    check();
                    assertCurrent(binding);
                  });
                },
              );
            } finally {
              await handle.dispose();
            }
          }),
        dispose: async () => {
          disposed = true;
          this.handles.delete(handle);
        },
      });
      this.handles.add(handle);
      assertCurrent(binding);
      return handle;
    });
  async dispose() {
    this.stop.abort();
    await this.lifetime.dispose();
  }
}
