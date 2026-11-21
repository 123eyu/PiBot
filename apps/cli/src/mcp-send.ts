import type { McpOptions } from "./args.ts";
import { type Headless, HeadlessError } from "./headless.ts";
import { configureModel, settle, targetBot, withDeadline } from "./run.ts";

export interface MessageInput {
  bot: string;
  message: string;
  newTopic?: boolean;
}

/** The headless message/terminal-state path, with no stdout streaming and approvals scoped to this run. */
export async function sendMessage(
  owner: Headless,
  options: McpOptions,
  input: MessageInput,
  signal: AbortSignal,
) {
  const deadline = Date.now() + options.timeoutMs;
  const bounded = <T>(work: Promise<T>, what: string) => withDeadline(work, what, deadline);
  await bounded(owner.ready, "startup");
  signal.throwIfAborted();
  const client = owner.client;
  const botId = await bounded(targetBot(client, input.bot), "bot list");
  if (options.provider)
    await bounded(configureModel(client, botId, options.provider), "model setup");
  signal.throwIfAborted();
  let runId: string | undefined;
  let sent = false;
  let settled = false;
  const early: { id: string; runId: string }[] = [];
  const decisions = new Set<Promise<unknown>>();
  const deny = (id: string) => {
    const work = client.call("approvals.resolve", { id, decision: "deny", remember: false });
    decisions.add(work);
    void work
      .catch(() => {
        // A run may end before its pending card is answered. No raw approval data is diagnostic.
      })
      .finally(() => decisions.delete(work));
  };
  const unsubscribe = client.on("approval.requested", (approval) => {
    if (approval.botId !== botId) return;
    if (runId === undefined) {
      if (early.length < 128) early.push({ id: approval.id, runId: approval.runId });
    } else if (approval.runId === runId) deny(approval.id);
  });
  try {
    // Do not cancel the receipt wait locally: an accepted run still needs its ID to be stopped.
    sent = true;
    const receipt = await bounded(
      client.call("chat.send", {
        botId,
        text: input.message,
        ...(input.newTopic ? { newTopic: true as const } : {}),
      }),
      "chat.send",
    );
    runId = receipt.runId;
    for (const approval of early) if (approval.runId === runId) deny(approval.id);
    const final = await settle(client, botId, receipt, deadline, signal, bounded);
    settled = true;
    if (signal.aborted || final.status === "aborted") throw new HeadlessError("aborted");
    if (final.status === "error")
      throw new HeadlessError(
        final.errorCode && /^[a-z][a-z0-9_]{0,63}$/.test(final.errorCode)
          ? final.errorCode
          : "run_failed",
      );
    return {
      botId,
      runId,
      conversationId: receipt.conversationId,
      messageId: receipt.assistantMessageId,
      reply: final.content.slice(0, 100_000).replace(/[\uD800-\uDBFF]$/u, ""),
      truncated: final.content.length > 100_000,
    };
  } catch (error) {
    try {
      if (sent && !settled) {
        if (runId) await client.call("chat.abort", { runId });
        else await owner.stop(); // A lost receipt cannot leave an unowned accepted run alive.
      }
    } catch {
      // A failed abort seals this owner; never accept another tool against an uncertain writer.
      await owner.stop();
      throw new HeadlessError("drain_unconfirmed");
    }
    throw error;
  } finally {
    unsubscribe();
    await Promise.allSettled(decisions);
  }
}
