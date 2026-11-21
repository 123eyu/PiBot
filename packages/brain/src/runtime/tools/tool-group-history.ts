import type { LocalToolCall, LocalToolDefinition, LocalToolResult } from "@pibot/agent";
import { BotsRepo, ConversationToolGroupsRepo } from "@pibot/storage";
import type { ToolRunContext } from "../../core/local-types.ts";
import { developmentRole } from "../../core/personas/development-roles.ts";
import type { LocalService } from "../../local-service.ts";

/** Per-run preference snapshot, never a source of permissions or reusable tool permits. */
export class ToolGroupHistory {
  private recent: string[];
  private active: readonly string[] = [];
  private readonly repo: ConversationToolGroupsRepo;
  private readonly scoped: boolean;
  constructor(
    private readonly local: LocalService,
    private readonly context: ToolRunContext,
  ) {
    this.repo = new ConversationToolGroupsRepo(local.deps.db);
    this.scoped = !!context.conversationId && !context.routineRunId && !context.executionTaskId;
    this.recent = this.scoped ? this.repo.recent(context.botId, context.conversationId ?? "") : [];
    // A role that writes or reviews code starts with code navigation, because
    // discovering the review group first would cost a turn on every fresh conversation. The Bot's
    // role is a mark only, so it can never widen what policy allows for a single call.
    this.initialReview = developmentRole(new BotsRepo(local.deps.db).get(context.botId)?.role?.id);
  }
  private readonly initialReview: boolean;
  initial() {
    // Undefined permits bounded legacy JSONL recovery; unattended/child runs never inherit it.
    return this.scoped && !this.recent.length ? undefined : this.recent;
  }
  /**
   * The group a development role starts with. It is offered separately from
   * `initial()` so that `undefined` keeps its meaning (legacy recovery) instead of being replaced
   * by a list that silently drops it.
   */
  always() {
    return this.initialReview ? ["review"] : [];
  }
  setActive(groups: readonly string[]) {
    this.active = [...groups];
  }
  snapshot(definitions: readonly LocalToolDefinition[]) {
    return {
      active: [...this.active],
      available: [...new Set(definitions.flatMap((tool) => tool.loadGroup?.id ?? []))],
    };
  }
  remember(
    call: LocalToolCall,
    result: LocalToolResult,
    definitions: readonly LocalToolDefinition[],
  ) {
    if (!this.scoped || result.isError || this.context.signal.aborted) return;
    const names = new Set(call.tool === "tool_discover" ? result.loadedTools : [call.tool]);
    const touched = [
      ...new Set(
        definitions.flatMap((tool) =>
          tool.loadGroup && names.has(tool.name) ? [tool.loadGroup.id] : [],
        ),
      ),
    ];
    if (!touched.length) return;
    this.recent = [...new Set([...touched, ...this.recent])].slice(0, 3);
    try {
      this.repo.remember(
        this.context.messageId,
        this.context.botId,
        this.context.conversationId ?? "",
        this.recent,
      );
    } catch {
      // A lost visibility hint must not turn a completed side effect into a retryable tool error.
      this.local.deps.logger.warn(
        JSON.stringify({
          module: "tool-groups",
          event: "remember_failed",
          botId: this.context.botId,
          runId: this.context.runId,
        }),
      );
    }
  }
}
