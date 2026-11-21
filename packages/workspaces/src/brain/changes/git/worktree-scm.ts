import type {
  WorkspaceChat as ChatService,
  WorkspaceLocal as LocalService,
} from "@pibot/brain/kit";
import { BotsRepo, transaction } from "@pibot/storage";
import { type ChangesTarget, type MethodParams, RpcError } from "@pibot/workspaces-contract/full";
import type { ManagedResourcePorts } from "../../managed/managed-resource-ports.ts";
import { discoverWorktrees, verifyWorktreeReceipt } from "../review/changes-worktree-views.ts";

/** SCM discovery and explicit review clicks never issue an execution binding. */
export class WorktreeScmService {
  constructor(
    private readonly local: LocalService,
    private readonly ports: ManagedResourcePorts,
    private readonly chat: ChatService,
  ) {}
  private async rows(target: ChangesTarget, signal: AbortSignal) {
    const scope = await this.ports.scope(
      {
        conversationKey: target.conversationKey,
        ...(target.topicId ? { topicId: target.topicId } : {}),
      },
      signal,
    );
    await this.ports.authorize(scope, "inspect", [scope.primary.path], signal);
    const rows = await discoverWorktrees(this.local, scope.primary, signal);
    return { scope, rows };
  }
  async list(input: MethodParams["worktrees.views"], signal: AbortSignal) {
    const { scope, rows } = await this.rows(input.target, signal);
    const limit = input.limit ?? 20;
    const start = input.before ? rows.findIndex(({ view }) => view.rootId === input.before) + 1 : 0;
    if (input.before && start === 0) throw new RpcError(-32602, "worktree_cursor_changed");
    const items = rows.slice(start, start + limit).map(({ view }) => {
      const managed = view.managed;
      const owned =
        managed &&
        (managed.taskId
          ? view.groupId === scope.groupId && view.sourceConversationId === scope.conversationId
          : managed.botId === scope.botId);
      const mutable =
        !!owned &&
        managed.state === "ready" &&
        !view.locked &&
        !view.prunable &&
        this.local.deps.platform === "darwin";
      return {
        ...view,
        capabilities: {
          ...view.capabilities,
          integrate: mutable,
          remove: mutable,
          recover:
            !!owned &&
            !managed.taskId &&
            (managed.state === "interrupted" || managed.state === "creating") &&
            this.local.deps.platform === "darwin",
          ...(mutable ? { reason: undefined } : {}),
        },
      };
    });
    return {
      items,
      nextBefore: start + limit < rows.length ? (items.at(-1)?.rootId ?? null) : null,
    };
  }
  async review(input: MethodParams["worktrees.review"], signal: AbortSignal) {
    const { scope, rows } = await this.rows(input.target, signal);
    const selected = rows.find(({ view }) => view.rootId === input.rootId);
    if (!selected || !scope.conversationId) throw new RpcError(-32602, "review_scope_invalid");
    const receipt = await verifyWorktreeReceipt(this.local, selected.receipt, signal);
    // This user click consents only to snapshot reads of the selected, verified project tree.
    const readScope = {
      ...scope,
      root: {
        ...scope.root,
        id: input.rootId,
        path: selected.view.path,
        role: "readonly" as const,
      },
    };
    await this.ports.authorize(readScope, "inspect", [selected.view.path], signal);
    const bot = new BotsRepo(this.local.deps.db).get(scope.botId);
    if (!bot?.modelProvider || !bot.modelId || bot.category === "image")
      throw new RpcError(-32602, "task_model_unsupported");
    const queueInput = {
      bot,
      conversationId: scope.conversationId,
      text: "",
      userInitiated: true,
      ...(scope.groupId ? { groupId: scope.groupId } : {}),
      worktreeReview: receipt,
    };
    const record = transaction(this.local.deps.db, () => this.chat.queue.insert(queueInput));
    this.chat.queue.publish(record, queueInput);
    this.local.approvals.audit.append({
      botId: scope.botId,
      runId: record.id,
      kind: "exec.started",
      summary: "Selected worktree independent review / 选中工作区独立审查",
      detail: { toolName: "worktrees.review", target: input.rootId, actor: "user" },
    });
    return {
      runId: record.id,
      botId: scope.botId,
      conversationId: scope.conversationId,
      rootId: input.rootId,
      path: receipt.root.path,
    };
  }
}
