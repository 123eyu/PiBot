import type { ComputerRunContext } from "@pibot/brain/kit";
import { auditText } from "@pibot/brain/kit";
import {
  type ComputerApp,
  type ComputerApprovalRequest,
  type ComputerGrant,
  type ComputerGrantResolve,
  RpcError,
  sameAppId,
} from "@pibot/computer-use-contract/full";
import type { PolicyResult } from "@pibot/policy";
import { explainPolicyResult } from "@pibot/policy";
import { AppBlocklistRepo, BotComputerAlwaysRepo, BotsRepo } from "@pibot/storage";

import type { ComputerContext } from "../../context.ts";
import {
  createGrantRow,
  type GrantOptions,
  newGrantToken,
  type RunGrant,
  unionApps,
} from "./computer-grants-issue.ts";

/** A pending "operate your computer" card and what the user chose on it. */
export interface PendingCard {
  context: ComputerRunContext;
  approvalId?: string;
  token: string;
  hash: string;
  offered: ComputerApp[];
  previous?: RunGrant;
  chosen?: GrantOptions & { always: boolean };
  row?: ComputerGrant;
  /** Answered because the conversation turned YOLO on, not by the user's click. */
  yolo?: boolean;
}

/**
 * Builds the card payload: the call's apps and the run's current apps are suggested (checked),
 * the Bot's always-list is listed pre-checked, and apps blocklisted since are shown locked.
 */
export function cardPayload(
  local: ComputerContext,
  input: {
    requested: ComputerApp[];
    previous?: RunGrant;
    always: ComputerApp[];
    coordinates: boolean;
    reason: ComputerApprovalRequest["reason"];
    providerName: string | null;
    modelAcceptsImages?: boolean;
  },
): { payload: ComputerApprovalRequest; offered: ComputerApp[] } {
  const offered = unionApps(input.requested, input.previous?.apps ?? [], input.always).slice(0, 50);
  const blocked = new AppBlocklistRepo(local.deps.db).blockedAmong(offered.map((app) => app.id));
  return {
    offered,
    payload: {
      apps: offered.map((app) => ({
        ...app,
        blocked: blocked.has(app.id),
        suggested: !blocked.has(app.id),
      })),
      reason: input.reason,
      coordinatesRequested: input.coordinates,
      providerName: input.providerName,
      modelAcceptsImages: input.modelAcceptsImages === true,
      alwaysAppIds: input.always
        .filter((app) => offered.some((held) => sameAppId(held.id, app.id)))
        .map((app) => app.id),
    },
  };
}

export function cardTitle(local: ComputerContext, botId: string, language: "zh" | "en"): string {
  const name = auditText(
    new BotsRepo(local.deps.db).get(botId)?.name ?? "Bot",
    local.deps.redactor,
  );
  return language === "zh" ? `${name} 想操作你的电脑` : `${name} wants to operate your computer`;
}

/**
 * Checks the user's choice on the card: a non-empty list without blocklisted apps.
 * Apps the card did not offer may be added by the user; their names come from `names`.
 */
export function chooseOnCard(
  local: ComputerContext,
  card: PendingCard,
  params: Extract<ComputerGrantResolve, { decision: "allow" }>,
  names: (id: string) => string,
): GrantOptions & { always: boolean } {
  if (new AppBlocklistRepo(local.deps.db).blockedAmong(params.apps).size)
    throw new RpcError(-32602, "computer_app_blocked");
  const apps = params.apps.map(
    (id) =>
      card.offered.find((app) => sameAppId(app.id, id)) ?? { id, name: names(id).slice(0, 200) },
  );
  return {
    apps,
    duration: params.duration,
    foregroundAsk: params.foregroundAsk,
    allowCoordinates: params.allowCoordinates,
    always: params.always === true,
  };
}

/**
 * Runs inside the approval's resolve transaction: creates the grant row and, for "don't ask
 * again", extends the Bot's always-list. A computer card resolved through the generic
 * `approvals.resolve` has no choice attached and is refused, so it cannot mint a grant.
 */
export function commitCard(local: ComputerContext, card: PendingCard): void {
  if (!card.chosen) throw new RpcError(-32602, "computer_grant_resolve_required");
  const { always, ...options } = card.chosen;
  card.row = createGrantRow(local.deps.db, local.approvals.audit, {
    context: card.context,
    options,
    hash: card.hash,
    approvalId: card.approvalId ?? null,
    previous: card.previous,
    actor: card.yolo ? "system" : "user",
    reasonCode: card.yolo ? "yolo" : "computer_card",
  });
  if (always) {
    const groupId = local.permissionScope(card.context);
    const apps = groupId
      ? options.apps
      : unionApps(
          new BotComputerAlwaysRepo(local.deps.db).get(card.context.botId)?.apps ?? [],
          options.apps,
        );
    if (groupId)
      local.approvals.grants.create({
        botId: card.context.botId,
        groupId,
        category: "computer",
        scope: { kind: "apps", apps: apps.map((app) => app.id) },
      });
    else new BotComputerAlwaysRepo(local.deps.db).set(card.context.botId, apps);
    local.approvals.audit.append({
      botId: card.context.botId,
      runId: card.context.runId,
      kind: "grant.created",
      summary: "Computer always-list updated / 已更新操作电脑的总是允许清单",
      detail: {
        category: "computer",
        programs: apps.map((app) => app.id),
        ...(groupId ? { groupId } : {}),
        actor: "user",
        reasonCode: "computer_always",
        ...(card.approvalId ? { approvalId: card.approvalId } : {}),
      },
    });
  }
}

export function newCard(
  context: ComputerRunContext,
  offered: ComputerApp[],
  previous?: RunGrant,
): PendingCard {
  return { context, offered, previous, ...newGrantToken() };
}

/** Re-evaluation when the user clicks "allow": policy may have changed since the card appeared. */
export function cardStillAllowed(
  local: ComputerContext,
  card: PendingCard,
  current: PolicyResult,
): PolicyResult {
  if (current.decision === "deny") return current;
  const chosen = card.chosen?.apps.map((app) => app.id) ?? [];
  if (new AppBlocklistRepo(local.deps.db).blockedAmong(chosen).size)
    return explainPolicyResult(
      { ...current, decision: "deny", reason: "app_blocked", canRemember: false },
      "boundary",
      "app_blocked",
    );
  return current;
}
