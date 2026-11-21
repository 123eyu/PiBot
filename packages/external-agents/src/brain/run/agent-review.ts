// An external agent has none of Pi Bot's tools, so "ask X to review" from the changes
// pane must not reach it as a message it would act on itself. Its run starts Pi Bot's own
// independent review instead: the same review_start path (frozen snapshot, read-only child task
// in the author's scope) with the chosen reviewer Bot's model and persona. When that child ends,
// Pi Bot's summary continuation is answered here too, from the review record, never by the agent.
import {
  type ChatReplies,
  type ChatRun,
  type ExternalAgentRunHost,
  reviewerChoices,
  type ToolRunContext,
  topicWorkplaceSnapshot,
} from "@pibot/brain/kit";
import { type Bot, ReviewSummarySchema } from "@pibot/external-agents-contract/full";
import { BotsRepo, RunsRepo, transaction } from "@pibot/storage";

type Local = NonNullable<ExternalAgentRunHost["local"]>;

const text = {
  started: {
    zh: (name: string) =>
      `已请${name}做独立只读审查。审查不在我这里运行，结果和发现会出现在改动面板的「审查与交付证据」里。`,
    en: (name: string) =>
      `${name} is doing an independent read-only review. It runs in Pi Bot, not in this agent; the result and findings appear under Review and delivery evidence in the changes panel.`,
  },
  noReviewer: {
    zh: () =>
      "没有可以审查的 Bot：外部 Agent 不能审查自己的改动，先建一个能用模型的 Bot（比如内置的小审）再请它审查。",
    en: () =>
      "No Bot can review this: an external agent cannot review its own changes. Create a Bot with a model (for example the built-in code reviewer) and ask it to review.",
  },
  finished: {
    zh: (name: string, findings: number) =>
      `${name}的独立审查结束：${findings} 个发现。详情见改动面板的「审查与交付证据」。`,
    en: (name: string, findings: number) =>
      `${name} finished the independent review with ${findings} finding${findings === 1 ? "" : "s"}. Details are under Review and delivery evidence in the changes panel.`,
  },
  failed: {
    zh: () => "独立审查没能开始，请在改动面板里重试。",
    en: () => "The independent review could not start. Try again from the changes panel.",
  },
};

export async function runAgentReview(input: {
  local: Local;
  deps: ExternalAgentRunHost;
  run: ChatRun;
  bot: Bot;
  context: ToolRunContext;
  replies: ChatReplies;
  route: { botId: string; conversationId: string };
  /** The changes pane's request; absent for the summary continuation after the review ended. */
  review?: { scope: "turn" | "uncommitted" };
}) {
  const { local, deps, run, bot, context, replies } = input;
  const zh = deps.language() === "zh";
  const bots = new BotsRepo(deps.db);
  const name = (id: string | undefined) => (id ? bots.get(id)?.name : undefined) ?? "Bot";
  let budgeted = false;
  let reply: string;
  try {
    if (input.review) {
      // Without another usable Bot the review would fall back to the author, which has no model.
      if (reviewerChoices(local, bot).reviewerId === bot.id)
        reply = text.noReviewer[zh ? "zh" : "en"]();
      else {
        const limits = local.execution.get({
          botId: bot.id,
          conversationId: run.conversationId,
        }).limits;
        local.budgets.begin(context, limits);
        budgeted = true;
        context.topicWorkplace = topicWorkplaceSnapshot(local, context);
        // The read-only child freezes this run's scope after the run itself has ended.
        local.retainRunContext(context);
        const result = await local.reviews.start(
          context,
          `agent-review-${run.runId}`,
          { scope: input.review.scope },
          context.signal,
        );
        const summary = ReviewSummarySchema.safeParse(JSON.parse(result.text)).data;
        reply = text.started[zh ? "zh" : "en"](name(summary?.reviewerBotId));
      }
    } else {
      const latest = (
        await local.reviews.list(
          { botId: bot.id, conversationId: run.conversationId },
          { limit: 1 },
          context.signal,
        )
      ).items[0];
      reply = text.finished[zh ? "zh" : "en"](
        name(latest?.reviewerBotId),
        latest?.findingsCount ?? 0,
      );
    }
  } catch (error) {
    deps.logger.warn(
      JSON.stringify({
        module: "external-agents",
        event: "agent_review_failed",
        botId: bot.id,
        runId: run.runId,
        errorName: error instanceof Error ? error.name : typeof error,
        code:
          error && typeof error === "object" && "message" in error
            ? String(error.message).slice(0, 80)
            : undefined,
      }),
    );
    reply = text.failed[zh ? "zh" : "en"]();
  }
  try {
    replies.event({ type: "replyStart" });
    replies.event({ type: "delta", text: reply });
    replies.flush();
    const updates = transaction(deps.db, () => {
      const updates = replies.finish("done", { stopReason: "stop" });
      new RunsRepo(deps.db).finish(run.runId, "done", "stop");
      return updates;
    });
    replies.publishUpdates(updates);
    deps.peer.emit("chat.done", {
      ...input.route,
      runId: run.runId,
      messageId: run.messageId,
      usage: { stopReason: "stop" },
      stopReason: "stop",
    });
  } finally {
    try {
      if (budgeted) local.budgets.end(context);
      replies.interruptAdditions();
    } finally {
      run.stopCause ??= { code: "completed" };
      run.controller.abort(run.stopCause);
      deps.finished(run);
    }
  }
}
