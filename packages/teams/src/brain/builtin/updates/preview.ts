/*
 * 「有新版本」: what the update card shows for one Bot or group, computed locally from the stored
 * provenance, the shipped history and the files on disk; no model call.
 */
import { textFingerprint } from "@pibot/brain/kit";
import { BotsRepo, GroupsRepo } from "@pibot/storage";
import type { BuiltinUpdatePreview } from "@pibot/teams-contract";
import { BuiltinRecoveriesRepo } from "../../../store/index.ts";
import { botPlan } from "./bot.ts";
import type { BuiltinUpdateDeps, Target } from "./common.ts";
import { groupPlan } from "./group.ts";

export async function preview(
  deps: BuiltinUpdateDeps,
  signal: () => AbortSignal,
  target: Target,
): Promise<BuiltinUpdatePreview | null> {
  const recoveries = new BuiltinRecoveriesRepo(deps.db);
  if ("botId" in target) {
    const found = await botPlan(deps, signal, target.botId);
    if (found) {
      const { plan, stored, role, name } = found;
      // Answered by a restore (or an explicit「保留当前」): nothing left to offer.
      if ((stored?.dismissedVersion ?? 0) >= plan.toVersion) return null;
      return {
        kind: "bot",
        state: "available",
        restorable: !!recoveries.bot(target.botId),
        sourceId: role.id,
        name,
        fromVersion: plan.fromVersion,
        toVersion: plan.toVersion,
        dismissed: false,
        provenance: plan.provenance,
        revision: plan.revision,
        changes: plan.changes,
        kept: plan.kept,
        members: [],
        quickStarts: [],
      };
    }
    const recovery = recoveries.bot(target.botId);
    const bot = new BotsRepo(deps.db).get(target.botId);
    if (!recovery || !bot?.role) return null;
    const content = await deps.builtin.content();
    const pack = content.roles.get(bot.role.id);
    const name = pack?.[deps.language()].template.bots[0]?.role?.name ?? bot.role.id;
    return {
      kind: "bot",
      state: "current",
      restorable: true,
      sourceId: bot.role.id,
      name,
      fromVersion: recovery.fromVersion,
      toVersion: Math.max(1, recovery.toVersion),
      dismissed: false,
      provenance: "recorded",
      revision: textFingerprint(JSON.stringify({ bot: bot.id, to: recovery.toVersion })),
      changes: [],
      kept: [],
      members: [],
      quickStarts: [],
    };
  }
  const found = await groupPlan(deps, signal, target.groupId);
  if (found) {
    const { plan, name } = found;
    if ((plan.origin.dismissedVersion ?? 0) >= plan.toVersion) return null;
    return {
      kind: "group",
      state: "available",
      restorable: !!recoveries.group(target.groupId),
      sourceId: plan.origin.templateId,
      name,
      fromVersion: plan.origin.version,
      toVersion: plan.toVersion,
      dismissed: false,
      provenance: plan.origin.provenance,
      revision: plan.revision,
      changes: plan.changes,
      kept: plan.kept,
      members: plan.members.map(({ roleId, name: member, existingBotName }) => ({
        roleId,
        name: member,
        ...(existingBotName ? { existingBotName } : {}),
      })),
      quickStarts: plan.quickStarts,
    };
  }
  const recovery = recoveries.group(target.groupId);
  const group = new GroupsRepo(deps.db).get(target.groupId);
  if (!recovery || !group) return null;
  const content = await deps.builtin.content();
  const pack = content.groups.get(recovery.sourceId);
  const name = pack?.[deps.language()].template.groups[0]?.name ?? recovery.sourceId;
  return {
    kind: "group",
    state: "current",
    restorable: true,
    sourceId: recovery.sourceId,
    name,
    fromVersion: recovery.fromVersion,
    toVersion: Math.max(1, recovery.toVersion),
    dismissed: false,
    provenance: "recorded",
    revision: textFingerprint(JSON.stringify({ group: group.id, to: recovery.toVersion })),
    changes: [],
    kept: [],
    members: [],
    quickStarts: [],
  };
}
