import type { Bot } from "@pibot/protocol-base";
import { ReviewProfileSchema } from "@pibot/protocol-base";
import { BotsRepo } from "@pibot/storage";
import { z } from "zod";
import type { LocalService } from "../../local-service.ts";

/** A reviewer has to be a live chat Bot with a model; image Bots and archived Bots never review. */
function usable(bot: Bot | undefined): bot is Bot {
  return (
    !!bot && !bot.archivedAt && bot.category === "chat" && !!bot.modelProvider && !!bot.modelId
  );
}

/**
 * Who reviews the author's code. The user's choice for this review, then the author's
 * default, then a recommendation: the built-in code reviewer role, a Bot on another model, any
 * other Bot. Undefined means the author reviews itself (the old behaviour, last resort).
 */
export function resolveReviewer(local: Pick<LocalService, "deps">, author: Bot, chosen?: string) {
  const bots = new BotsRepo(local.deps.db);
  for (const id of [chosen, author.reviewBotId]) {
    if (!id) continue;
    const bot = bots.get(id);
    if (usable(bot)) return bot.id === author.id ? undefined : bot;
  }
  const others = bots.list().filter((bot) => bot.id !== author.id && usable(bot));
  return (
    others.find((bot) => bot.role?.id === "code-reviewer") ??
    others.find(
      (bot) => bot.modelProvider !== author.modelProvider || bot.modelId !== author.modelId,
    ) ??
    others[0]
  );
}

/**
 * The review child keeps the author's identity, permissions and scope (read-only review tools);
 * only the thinking — model, thinking level, persona, norms, role and name — is the reviewer's.
 * The reviewer's memory, connections and permissions never come along.
 */
export function reviewerBrain(author: Bot, reviewer: Bot): Bot {
  // An external agent's code reviewed by a Pi Bot Bot: the child thinks in Pi Bot's runtime.
  const { kind: _kind, ...identity } = author;
  return {
    ...identity,
    name: reviewer.name,
    isMain: false,
    modelProvider: reviewer.modelProvider,
    modelId: reviewer.modelId,
    thinkingLevel: reviewer.thinkingLevel,
    thinkingPreference: reviewer.thinkingPreference ?? null,
    systemPrompt: reviewer.systemPrompt,
    norms: reviewer.norms,
    role: reviewer.role ?? null,
  };
}

/** The reviewer of an execution child task, when that task is a review by another Bot. */
export function taskReviewer(local: LocalService, taskId: string): Bot | undefined {
  const authority = local.tasks.tasks.internal(taskId)?.authority;
  const profile = z
    .object({ reviewProfile: ReviewProfileSchema.optional() })
    .safeParse(authority ?? {});
  const id = profile.success ? profile.data.reviewProfile?.reviewerBotId : undefined;
  if (!id) return;
  const bot = new BotsRepo(local.deps.db).get(id);
  return usable(bot) ? bot : undefined;
}

/**
 * What the changes pane offers. `reviewerId` is who the plain "ask X to review" button
 * uses now (the author's own id when only the author is left); `recommendedId` ignores the saved
 * default so the menu can still mark the recommendation.
 */
export function reviewerChoices(local: Pick<LocalService, "deps">, author: Bot) {
  const saved = author.reviewBotId
    ? new BotsRepo(local.deps.db).get(author.reviewBotId)
    : undefined;
  const bots = new BotsRepo(local.deps.db).list().filter(usable).slice(0, 200);
  return {
    authorId: author.id,
    reviewerId: resolveReviewer(local, author)?.id ?? author.id,
    defaultId: usable(saved) ? saved.id : null,
    recommendedId: resolveReviewer(local, { ...author, reviewBotId: null })?.id ?? author.id,
    builtinMissing: !bots.some((bot) => bot.role?.id === "code-reviewer"),
    bots,
  };
}
