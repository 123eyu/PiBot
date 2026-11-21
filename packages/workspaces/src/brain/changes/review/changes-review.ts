import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { LocalToolResult } from "@pibot/agent";
import { type PreparedTool, reviewerChoices, type ToolRunContext } from "@pibot/brain/kit";
import { containsPath } from "@pibot/policy";
import {
  BotsRepo,
  ReviewFindingsRepo,
  RunFileChangesRepo,
  RunsRepo,
  transaction,
} from "@pibot/storage";
import {
  type MethodParams,
  type MethodResults,
  type ReviewSeverity,
  RpcError,
} from "@pibot/workspaces-contract/full";
import type { ChangesService } from "../changes-service.ts";

/**
 * "ask the Bot to review" results attached to lines. The Bot reports each
 * finding with the read-only review_finding tool; rows are keyed to that run and the run's
 * primary folder, and the sidebar reads the newest review of its conversation and folder.
 */
export interface ReviewFindingInput {
  path: string;
  line?: number;
  endLine?: number;
  severity: ReviewSeverity;
  message: string;
}

const SEVERITY = {
  security: ["安全", "security"],
  bug: ["会出错", "bug"],
  suggestion: ["建议", "suggestion"],
} as const;

/** Folder-relative "/" path of the finding, or undefined when it points outside the primary folder. */
async function folderPath(
  root: string,
  cwd: string,
  path: string,
  platform: ChangesService["platform"],
) {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  // The file may be deleted by the change under review; resolve the nearest existing parent.
  let real = absolute;
  const missing: string[] = [];
  for (let at = absolute; ; ) {
    const found = await realpath(at).catch(() => undefined);
    if (found) {
      real = join(found, ...missing);
      break;
    }
    const parent = dirname(at);
    if (parent === at) break;
    missing.unshift(basename(at));
    at = parent;
  }
  if (!containsPath(root, real, platform)) return undefined;
  const value = relative(root, real).split(/[\\/]/).join("/");
  return value && !value.startsWith("../") && value !== ".." ? value : undefined;
}

export async function recordFinding(
  changes: ChangesService,
  context: ToolRunContext,
  prepared: PreparedTool,
  input: ReviewFindingInput,
): Promise<LocalToolResult> {
  const zh = context.language === "zh";
  const boundary = prepared.boundary;
  const root = boundary?.roots.find((item) => item.id === boundary.primaryId)?.canonicalPath;
  const path = root
    ? await folderPath(root, prepared.cwd, input.path, changes.platform)
    : undefined;
  if (!root || !path)
    return {
      text: "审查发现的文件必须在当前主文件夹里 / The finding's file must be inside the current primary folder",
      isError: true,
    };
  const line = input.line ?? null;
  const endLine = line && input.endLine && input.endLine > line ? input.endLine : null;
  const finding = new ReviewFindingsRepo(changes.local.deps.db).record({
    botId: context.botId,
    ...(context.groupId ? { groupId: context.groupId } : {}),
    ...(context.conversationId ? { conversationId: context.conversationId } : {}),
    runId: context.runId,
    root,
    path,
    line,
    endLine,
    severity: input.severity,
    message: changes.local.deps.redactor.redact(input.message.trim()).slice(0, 2000),
  });
  if (!finding)
    return {
      text: "这次审查记录的发现已达上限（200 条），请在回复里总结其余问题 / This review reached its 200-finding limit; summarize the rest in your reply",
      isError: true,
    };
  changes.local.deps.peer.emit("changes.changed", { runId: context.runId, reason: "review" });
  const where = line ? (zh ? `第 ${line} 行` : `line ${line}`) : zh ? "整个文件" : "whole file";
  const label = SEVERITY[input.severity][zh ? 0 : 1];
  return {
    text: "已记录，会显示在改动侧栏对应的行上 / Recorded; it appears on that line in the changes sidebar",
    summary: zh ? `审查发现（${label}）：${path} ${where}` : `Finding (${label}): ${path} ${where}`,
  };
}

export async function listReviews(
  changes: ChangesService,
  params: MethodParams["changes.reviews"],
  signal: AbortSignal,
) {
  const scope = await changes.scope(params, signal);
  let result = new ReviewFindingsRepo(changes.local.deps.db).latest({
    botId: scope.botId,
    ...(scope.groupId ? { groupId: scope.groupId } : {}),
    ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
    root: scope.root.path,
  });
  let freshness: MethodResults["changes.reviews"]["freshness"] = "unavailable";
  const repository = changes.local.reviews.repo;
  const bound = result.runId ? repository.forRun(result.runId) : undefined;
  const latest = repository.latestForFolder({
    botId: scope.botId,
    conversationId: scope.conversationId,
    groupId: scope.groupId,
    root: scope.root.path,
  });
  const legacyAt = result.runId
    ? new RunsRepo(changes.local.deps.db).get(result.runId)?.createdAt
    : undefined;
  const record =
    latest &&
    (!legacyAt || latest.summary.createdAt >= legacyAt || latest.summary.id === bound?.summary.id)
      ? latest
      : bound;
  if (record)
    result = {
      runId: record.summary.reviewerRunId ?? result.runId,
      findings: repository.findings(record.summary.id).findings,
    };
  // Legacy comments have no immutable version: keep them as history rather than current proof.
  if (
    record &&
    record.root === scope.root.path &&
    record.source.groupId === scope.groupId &&
    record.summary.conversationId === scope.conversationId
  ) {
    try {
      const review = await changes.local.reviews.get(
        {
          botId: record.summary.botId,
          conversationId: record.summary.conversationId,
        },
        record.summary.id,
        signal,
      );
      freshness = review.freshness === "checking" ? "unavailable" : review.freshness;
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof RpcError)) throw error;
      // Missing access or expired source leaves the stored comments available only as history.
    }
  }
  if (record && record.summary.status !== "done") freshness = "unavailable";
  const latestChange = new RunFileChangesRepo(changes.local.deps.db).latestRun({
    botId: scope.botId,
    ...(scope.groupId ? { groupId: scope.groupId } : {}),
    ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
  });
  const changedRun = latestChange
    ? new RunsRepo(changes.local.deps.db).get(latestChange)
    : undefined;
  if (record && changedRun && changedRun.createdAt > record.summary.createdAt) freshness = "stale";
  const reviewerId = record?.summary.reviewerBotId;
  const reviewerName = reviewerId
    ? new BotsRepo(changes.local.deps.db).get(reviewerId)?.name
    : undefined;
  return { ...result, freshness, ...(reviewerName ? { reviewerName } : {}) };
}

/**
 * Registers the review the user just asked for (its message was accepted), keyed to the primary
 * folder where its findings are recorded. Without this a review with no findings left the
 * previous review's findings showing. The run may already be done; the event re-reads it then.
 */
export async function startReview(
  changes: ChangesService,
  params: MethodParams["changes.reviewStart"],
  signal: AbortSignal,
) {
  const scope = await changes.scope(params, signal);
  const db = changes.local.deps.db;
  const runIds = transaction(db, () =>
    new ReviewFindingsRepo(db).start({
      botId: scope.botId,
      ...(scope.groupId ? { groupId: scope.groupId } : {}),
      ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
      root: scope.primary.path,
    }),
  );
  if (runIds.length) changes.notify(scope, "review");
  return { runIds };
}

/** The reviewer menu of the changes pane; the author is the chat's Bot (a group's coordinator). */
export async function listReviewers(
  changes: ChangesService,
  params: MethodParams["changes.reviewers"],
  signal: AbortSignal,
): Promise<MethodResults["changes.reviewers"]> {
  const scope = await changes.scope(params, signal);
  const author = new BotsRepo(changes.local.deps.db).get(scope.botId);
  if (!author) throw new RpcError(-32602, "Unknown active Bot");
  const choices = reviewerChoices(changes.local, author);
  return {
    ...choices,
    bots: choices.bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      modelId: bot.modelId,
      avatarShape: bot.avatarShape,
      avatarColor: bot.avatarColor,
      avatarEyes: bot.avatarEyes,
      ...(bot.avatarImage ? { avatarImage: bot.avatarImage } : {}),
      ...(bot.role ? { role: bot.role } : {}),
    })),
  };
}

/** Remember the reviewer the user picked; the author's next review_start uses it once. */
export async function setReviewer(
  changes: ChangesService,
  params: MethodParams["changes.reviewerSet"],
  signal: AbortSignal,
) {
  const scope = await changes.scope(params, signal);
  changes.local.reviews.choose(scope.botId, params.botId, params.review);
  return { ok: true as const };
}

export async function updateReviews(
  changes: ChangesService,
  params: MethodParams["changes.reviewUpdate"],
  signal: AbortSignal,
) {
  const scope = await changes.scope(params, signal);
  const db = changes.local.deps.db;
  transaction(db, () =>
    new ReviewFindingsRepo(db).setState(
      {
        botId: scope.botId,
        ...(scope.groupId ? { groupId: scope.groupId } : {}),
        ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
        root: scope.root.path,
      },
      params.ids,
      params.state,
    ),
  );
  changes.notify(scope, "review");
  return { ok: true as const };
}
