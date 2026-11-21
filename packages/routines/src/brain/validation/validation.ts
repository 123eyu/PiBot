import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentRuntime } from "@pibot/agent";
import type { LocalService } from "@pibot/brain/kit";
import {
  connectorPreauthIssue,
  explicitWorkplace,
  requireImageModel,
  routineSelectionFor,
} from "@pibot/brain/kit";
import { containsPath, siteCovers } from "@pibot/policy";
import {
  type Bot,
  canonicalImageModelId,
  type Routine,
  type RoutineDraft,
  type RoutineDraftInput,
  RoutineDraftSchema,
  RpcError,
} from "@pibot/protocol";
import { cronFieldIssue } from "@pibot/routines-contract";
import { CronInputError, scanFolder, validateCron } from "@pibot/scheduler";
import { AppBlocklistRepo, BotsRepo } from "@pibot/storage";
import { routinePreauthKey } from "../../store/index.ts";
import { catalogTools, isLocalCalendar, usableConnection } from "../triggers/app-read.ts";
import { presetCall } from "../triggers/connection-checks.ts";

/**
 * Save- and resume-time gate of the triggers that read a connection. A retired GitHub
 * trigger is refused so a saved task always has a trigger that can fire.
 */
export function appTriggerIssue(
  local: LocalService,
  botId: string,
  trigger: RoutineDraft["triggers"][number],
) {
  if (trigger.kind === "github") throw new RpcError(-32602, "routine_github_trigger_retired");
  if (trigger.kind !== "connection" && trigger.kind !== "calendar") return;
  const connector = usableConnection(local, botId, trigger.connectorId);
  if (trigger.kind === "connection" && !connector)
    throw new RpcError(-32602, "connection_trigger_unavailable");
  // The chosen preset must be answerable by this connection's current read-only tools.
  if (
    trigger.kind === "connection" &&
    !presetCall(trigger.check, catalogTools(local, botId, trigger.connectorId))
  )
    throw new RpcError(-32602, "connection_trigger_check_unavailable");
  if (trigger.kind === "calendar" && (!connector || !isLocalCalendar(local, connector)))
    throw new RpcError(-32602, "calendar_trigger_unavailable");
}

export async function validateRoutine(
  local: LocalService,
  input: RoutineDraftInput,
  minimum: number,
  signal: AbortSignal,
  retained: ReadonlySet<string> = new Set(),
  agent?: AgentRuntime,
): Promise<RoutineDraft> {
  const parsed = RoutineDraftSchema.parse(input);
  // Every saved routine names its own folders; "follow the Bot" becomes the new-topic default.
  const draft = { ...parsed, workplace: explicitWorkplace(local, parsed.botId, parsed.workplace) };
  const bot = new BotsRepo(local.deps.db).get(draft.botId);
  // An external agent Bot may run routines, but not one that cannot start on this
  // computer (Windows before the user confirmed running it unisolated, no isolation, no program).
  if (bot?.kind === "agent") {
    const readiness = local.externalAgentProvider?.stepReadiness?.(bot.id) ?? "unavailable";
    if (readiness !== "ok")
      throw new RpcError(
        -32602,
        readiness === "unconfirmed" ? "routine_agent_unconfirmed" : "routine_agent_unavailable",
      );
  }
  if (bot?.category === "image") {
    if (!agent) throw new RpcError(-32602, "image_model_unavailable");
    await requireImageModel(
      local.images,
      bot.modelProvider && bot.modelId
        ? { provider: bot.modelProvider, id: bot.modelId }
        : undefined,
      "text-to-image",
      signal,
    );
  }
  if (draft.workplace.kind === "folder") {
    const ids = [
      ...(draft.workplace.folderId === "home" ? [] : [draft.workplace.folderId]),
      ...(draft.workplace.readonly ?? []),
    ];
    if (local.workplaces.repo.folders(draft.botId, ids).size !== new Set(ids).size)
      throw new RpcError(-32602, "Unknown routine workplace");
    // A kept working directory is never a new root: it must already be one of the folders.
    const cwd = draft.workplace.cwd;
    if (cwd && cwd !== "home" && cwd !== draft.workplace.folderId && !ids.includes(cwd))
      throw new RpcError(-32602, "Unknown routine workplace");
  }
  const workplace = await local.workplaces.context(
    draft.botId,
    signal,
    routineSelectionFor(local, draft),
  );
  await validateRoutineTriggers(local, draft.triggers, minimum, signal);
  for (const trigger of draft.triggers) appTriggerIssue(local, draft.botId, trigger);
  const permissions = local.permissions.effective(draft.botId),
    levels = permissions.levels;
  for (const op of draft.preauth) {
    if (retained.has(routinePreauthKey(op))) continue;
    if (levels[op.category] === "never")
      throw new RpcError(-32602, "Preauthorization exceeds permission ceiling");
    if (
      op.scope.kind === "domain" &&
      !permissions.network.allowAll &&
      !permissions.network.domains.includes(op.scope.domain)
    )
      throw new RpcError(-32602, "Preauthorization exceeds network ceiling");
    // Operating the computer is preauthorized per app list; blocklisted apps never are.
    if (op.scope.kind === "apps") {
      if (new AppBlocklistRepo(local.deps.db).blockedAmong(op.scope.apps).size)
        throw new RpcError(-32602, "Preauthorization includes a blocked app");
      continue;
    }
    // Submitting forms is bounded by its site and the network list, no folder.
    if (op.scope.kind === "submit") {
      const domain = op.scope.domain;
      if (
        !permissions.network.allowAll &&
        !permissions.network.domains.some((entry) => siteCovers(entry, domain))
      )
        throw new RpcError(-32602, "Preauthorization exceeds network ceiling");
      continue;
    }
    // An automatic login needs an account saved for that site and granted to this Bot.
    if (op.scope.kind === "login") {
      const site = op.scope.site;
      if (!local.credentials.hasSite(draft.botId, site))
        throw new RpcError(-32602, "Preauthorization has no saved account");
      continue;
    }
    if (op.scope.kind === "connector" || op.scope.kind === "send_target") {
      if (connectorPreauthIssue(local, draft.botId, op))
        throw new RpcError(-32602, "Connector preauthorization is unavailable");
      continue;
    }
    // Owner decision 2026-10-23: paid generation is pre-approved for this image Bot's current
    // model only; changing the model voids it at run time (the image gate matches exactly).
    if (op.scope.kind === "paid_image") {
      if (!paidImageMatchesBot(bot, op.scope))
        throw new RpcError(-32602, "Paid image preauthorization does not match the Bot's model");
      continue;
    }
    if (op.scope.kind === "secret")
      throw new RpcError(-32602, "Routine cannot remember secret consent");
    // Routine consent for web stays per site; "read public pages" is chat-only.
    if (op.scope.kind === "connector_tool" || op.scope.kind === "web_read")
      throw new RpcError(-32602, "Unsupported preauthorization scope");
    const root =
      op.scope.kind === "folder"
        ? op.scope.path
        : op.scope.kind === "domain"
          ? null
          : op.scope.root;
    if (root) {
      const canonical = await realpath(root);
      if (canonical !== resolve(root)) throw new RpcError(-32602, "Preauthorization root changed");
      if (op.category === "write_file" || op.category === "run_command") {
        if (
          !workplace.boundary.writeRoots.some((r) =>
            containsPath(r, canonical, local.deps.platform),
          ) ||
          workplace.boundary.denyWriteRoots.some((r) =>
            containsPath(r, canonical, local.deps.platform),
          ) ||
          workplace.boundary.conflict !== "none"
        )
          throw new RpcError(-32602, "Preauthorization cannot promote readonly roots");
      }
    }
  }
  return draft;
}

/** Whether a paid image scope names this image Bot's current model (canonical id). */
export function paidImageMatchesBot(
  bot: Pick<Bot, "category" | "modelProvider" | "modelId"> | undefined,
  scope: { provider: string; model: string },
) {
  return (
    bot?.category === "image" &&
    !!bot.modelProvider &&
    !!bot.modelId &&
    scope.provider === bot.modelProvider &&
    scope.model === canonicalImageModelId(bot.modelProvider, bot.modelId)
  );
}

// Preserving a stale consent is not re-consent; the execution gate still checks its old snapshot.
export function retainedPreauth(old: Routine | undefined, input: { botId: string }) {
  return new Set(
    old?.botId === input.botId ? old.preauth.map((p) => routinePreauthKey(p.operation)) : [],
  );
}

export async function validateRoutineTriggers(
  local: LocalService,
  triggers: import("@pibot/protocol").RoutineDraft["triggers"],
  minimum: number,
  signal: AbortSignal,
) {
  const dataDir = triggers.some((t) => t.kind === "folder")
    ? await realpath(local.deps.dataDir)
    : local.deps.dataDir;
  for (const trigger of triggers) {
    signal.throwIfAborted();
    if (trigger.kind === "cron") {
      const issue = cronFieldIssue(trigger.expr);
      if (issue) throw new RpcError(-32602, `routine_cron_${issue}`);
      try {
        await validateCron(trigger.expr, trigger.timezone, minimum, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof CronInputError)) throw error;
        throw new RpcError(
          -32602,
          error.message === "cron_too_frequent"
            ? "routine_cron_minimum"
            : error.message === "invalid_timezone"
              ? "routine_cron_timezone"
              : "routine_cron_syntax",
        );
      }
    } else if (trigger.kind === "folder") {
      const canonical = await realpath(trigger.path),
        info = await lstat(trigger.path);
      if (
        canonical !== resolve(trigger.path) ||
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        containsPath(dataDir, canonical, local.deps.platform)
      )
        throw new RpcError(-32602, "Invalid monitor directory");
      await scanFolder(trigger, dataDir, signal, Date.now());
    }
  }
}
