/*
 * The group side of the built-in update flow: which templates have a newer version, the members a
 * new version offers, the steps that write the group and its members' skills back, and the
 * automatic pass that runs them.
 */
import { skillFingerprint } from "@pibot/brain/kit";
import { type Bot, type Group, RpcError, RpcErrorCodes } from "@pibot/protocol";
import { BotsRepo, GroupsRepo, MessagesRepo, transaction } from "@pibot/storage";
import type { BuiltinChange } from "@pibot/teams-contract";
import {
  BuiltinBaselinesRepo,
  BuiltinRecoveriesRepo,
  type GroupRecovery,
} from "../../../store/index.ts";
import { type GroupPlan, groupOrigin, planGroupUpdate } from "../group-update.ts";
import { snapshotBot } from "./bot.ts";
import {
  type Apply,
  audit,
  type BuiltinUpdateDeps,
  changed,
  counts,
  unavailable,
} from "./common.ts";

export async function groupPlan(
  deps: BuiltinUpdateDeps,
  _signal: () => AbortSignal,
  groupId: string,
  force = false,
) {
  const group = new GroupsRepo(deps.db).get(groupId);
  if (!group) throw new RpcError(RpcErrorCodes.invalidParams, "Unknown group");
  const content = await deps.builtin.content();
  const repo = new BotsRepo(deps.db);
  const bots = new Map<string, Bot>();
  for (const member of group.members) {
    const bot = repo.get(member.botId);
    if (bot && !bot.archivedAt) bots.set(bot.id, bot);
  }
  const stored = new BuiltinBaselinesRepo(deps.db).group(groupId);
  const origin = groupOrigin(group, bots.get(group.coordinatorBotId)?.role?.id, content, stored);
  const pack = origin && content.groups.get(origin.templateId);
  const version = pack?.zh.template.groups[0]?.template?.version ?? 0;
  if (!origin || !pack || version <= origin.version) return undefined;
  const inGroup = new Set(bots.keys());
  const existing = new Map([...deps.builtin.existing()].filter(([, bot]) => !inGroup.has(bot.id)));
  const plan = planGroupUpdate({
    group,
    bots,
    origin,
    content,
    ...(content.history ? { history: content.history } : {}),
    existing,
    language: deps.language(),
    redact: (text) => deps.redactor.redact(text),
    ...(force ? { force } : {}),
  });
  const name = pack[deps.language()].template.groups[0]?.name ?? origin.templateId;
  return { group, plan, name };
}

export async function applyGroup(
  deps: BuiltinUpdateDeps,
  signal: () => AbortSignal,
  groupId: string,
  params: Apply,
) {
  const found = await groupPlan(deps, signal, groupId);
  if (!found) throw unavailable();
  const { group, plan } = found;
  if (plan.toVersion !== params.toVersion || plan.revision !== params.revision) throw changed();
  const picked = [...new Set("addMembers" in params ? (params.addMembers ?? []) : [])];
  const offered = new Set(plan.members.map((member) => member.roleId));
  if (picked.some((roleId) => !offered.has(roleId)))
    throw new RpcError(RpcErrorCodes.invalidParams, "builtin_member_unknown");
  if (group.members.length + picked.length > 6)
    throw new RpcError(RpcErrorCodes.invalidParams, "builtin_group_full");
  if (
    plan.coordinatorRole &&
    offered.has(plan.coordinatorRole) &&
    !picked.includes(plan.coordinatorRole)
  )
    throw new RpcError(RpcErrorCodes.invalidParams, "builtin_coordinator_member_required");
  const failed = await runGroup(deps, signal, group, plan, picked, false);
  return { ok: true as const, failed };
}

export async function runGroup(
  deps: BuiltinUpdateDeps,
  signal: () => AbortSignal,
  group: Group,
  plan: GroupPlan,
  picked: readonly string[],
  automatic: boolean,
) {
  const groupId = group.id;
  const failed: BuiltinChange[] = [];
  const step = async (what: BuiltinChange[], action: () => Promise<unknown>) => {
    try {
      await action();
    } catch {
      deps.logger.warn(
        JSON.stringify({
          module: "builtin",
          event: "update_step_failed",
          groupId,
          items: what.map((c) => c.item),
        }),
      );
      failed.push(...what);
    }
  };
  const offered = new Map(plan.members.map((member) => [member.roleId, member]));
  for (const roleId of picked) {
    const member = offered.get(roleId);
    await step([{ item: "member", action: "add", name: member?.name ?? roleId }], async () => {
      const botId = member?.existingBotId ?? (await deps.builtin.createBot({ roleId })).bot.id;
      await deps.groups.addMember(groupId, botId);
    });
  }
  if (
    plan.patch.announcement !== undefined ||
    plan.patch.autoRoundLimit !== undefined ||
    plan.coordinatorRole
  )
    await step(
      plan.changes.filter((c) => ["announcement", "roundLimit", "coordinator"].includes(c.item)),
      async () => {
        const current = new GroupsRepo(deps.db).get(groupId);
        if (
          !current ||
          current.coordinatorBotId !== group.coordinatorBotId ||
          current.announcement !== group.announcement ||
          current.autoRoundLimit !== group.autoRoundLimit
        )
          throw changed();
        const coordinator = plan.coordinatorRole
          ? current.members.find(
              (member) =>
                new BotsRepo(deps.db).get(member.botId)?.role?.id === plan.coordinatorRole,
            )
          : undefined;
        if (plan.coordinatorRole && !coordinator) throw unavailable();
        await deps.groups.update({
          groupId,
          ...plan.patch,
          ...(coordinator ? { coordinatorBotId: coordinator.botId } : {}),
        });
      },
    );
  // Each member's skills follow this template's list for its role, so a template that
  // carries only some of the role's skills never brings the rest back.
  await syncMemberSkills(deps, signal, group, plan, failed);
  const target = `${plan.origin.templateId}@${plan.origin.version}->${plan.toVersion}`;
  const added = picked.length - failed.filter((c) => c.item === "member").length;
  transaction(deps.db, () => {
    if (!failed.length && plan.quickStarts.length) {
      const starts = plan.quickStarts.map((text) => deps.redactor.redact(text));
      new MessagesRepo(deps.db).create({
        conversationId: group.conversationId,
        botId: group.coordinatorBotId,
        role: "assistant",
        status: "done",
        content: deps.language() === "zh" ? "可以这样开始：" : "Try starting with:",
        usage: { groupQuickStarts: starts },
      });
    }
    if (!failed.length)
      new BuiltinBaselinesRepo(deps.db).setGroup(groupId, plan.origin.templateId, plan.toVersion, {
        ...plan.baseline,
        coordinatorBotId: plan.kept.some((line) => line.item === "coordinator")
          ? plan.origin.baseline?.coordinatorBotId
          : new GroupsRepo(deps.db).get(groupId)?.coordinatorBotId,
      });
    audit(
      deps,
      group.coordinatorBotId,
      {
        groupId,
        reasonCode: failed.length ? "partial" : automatic ? "auto" : "adopted",
        target,
        reason: `${counts(plan.changes, plan.kept)} added=${added}`,
      },
      failed.length
        ? "Group template update incomplete / 群模板更新未完成"
        : automatic
          ? "Group template updated automatically / 群模板已自动更新"
          : "Group template updated / 群模板已更新",
    );
  });
  deps.peer.emit("groups.changed", { groupId, reason: "updated" });
  return failed;
}

/**
 * Brings one group member's skills in line with the template's list for its role. Only
 * built-in copies are touched (a skill of the user's own is never removed); the member's own
 * version is kept as a recovery record when anything changes.
 */
export async function syncMemberSkills(
  deps: BuiltinUpdateDeps,
  signal: () => AbortSignal,
  group: Group,
  plan: GroupPlan,
  failed: BuiltinChange[],
): Promise<void> {
  const content = await deps.builtin.content();
  const team = content.groups.get(plan.origin.templateId)?.[plan.language];
  if (!team) return;
  const bots = new BotsRepo(deps.db);
  for (const member of group.members) {
    const bot = bots.get(member.botId);
    if (!bot || bot.archivedAt || bot.category === "image" || !bot.role) continue;
    const index = team.template.bots.findIndex((entry) => entry.role?.id === bot.role?.id);
    const packages = index >= 0 ? (team.skills[index] ?? []) : [];
    if (!packages.length) continue;
    // Each member gets its own budget, as before the split: one slow Bot must not starve the rest.
    const rows = await deps.skills().inventory(bot.id, signal(), { skipSharedContent: true });
    const byFolder = new Map(
      rows.filter((row) => row.source === "team").map((row) => [row.folder, row]),
    );
    const wanted = new Map(
      packages.map((pkg) => [pkg.folder, skillFingerprint(pkg.document, pkg.files)]),
    );
    const touches = packages.some(
      (pkg) => byFolder.get(pkg.folder)?.fingerprint !== wanted.get(pkg.folder),
    );
    const drops = [...byFolder.keys()].some((folder) => !wanted.has(folder));
    if (!touches && !drops) continue;
    new BuiltinRecoveriesRepo(deps.db).setBot(
      bot.id,
      bot.role.id,
      bot.role.version,
      bot.role.version,
      await snapshotBot(deps, signal, bot, plan.language, rows),
    );
    for (const pkg of packages) {
      const row = byFolder.get(pkg.folder);
      if (row?.fingerprint === wanted.get(pkg.folder)) continue;
      try {
        if (row) await deps.skills().replace(bot.id, row.id, pkg.document, pkg.files);
        else
          await deps.skills().create(bot.id, pkg.document, "team", {
            enabled: pkg.enabled,
            files: pkg.files,
            folder: pkg.folder,
          });
      } catch {
        failed.push({ item: "skill", action: row ? "update" : "add", name: pkg.document.name });
      }
    }
    for (const [folder, row] of byFolder) {
      if (wanted.has(folder)) continue;
      try {
        await deps.skills().remove(bot.id, row.id);
      } catch {
        failed.push({ item: "skill", action: "remove", name: row.name });
      }
    }
    deps.peer.emit("bots.changed", { botId: bot.id, reason: "updated" });
  }
}

export async function autoGroup(
  deps: BuiltinUpdateDeps,
  signal: () => AbortSignal,
  groupId: string,
) {
  const found = await groupPlan(deps, signal, groupId, true);
  if (!found) return;
  const { group, plan } = found;
  // A template changing its coordinator must remain available for an explicit preview/adoption.
  // The automatic force pass otherwise overwrites edited announcements and adds members without consent.
  if (plan.coordinatorAdoption) return;
  if ((plan.origin.dismissedVersion ?? 0) >= plan.toVersion) return;
  const recovery: GroupRecovery = {
    kind: "group",
    language: plan.language,
    announcement: group.announcement,
    autoRoundLimit: group.autoRoundLimit,
  };
  new BuiltinRecoveriesRepo(deps.db).setGroup(
    groupId,
    plan.origin.templateId,
    plan.origin.version,
    plan.toVersion,
    recovery,
  );
  // The user made no choice this time: every member the new version adds joins.
  const room = Math.max(0, 6 - group.members.length);
  await runGroup(
    deps,
    signal,
    group,
    plan,
    plan.members.map((member) => member.roleId).slice(0, room),
    true,
  );
}
