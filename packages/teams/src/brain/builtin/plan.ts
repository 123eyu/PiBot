import {
  BUILTIN_MAX_BOTS,
  BUILTIN_MAX_GROUPS,
  type BuiltinPlan,
  type BuiltinSelection,
  botNameKey,
  freeBotName,
  RpcError,
  RpcErrorCodes,
  type TeamTemplate,
} from "@pibot/protocol";
import type { ResolvedTeam, TeamSkillPackage } from "../teams/team-archive.ts";
import type { BuiltinContent, BuiltinPack } from "./load.ts";

export interface PlanContext {
  imageAvailable: boolean;
  /** Active Bots created from each role, newest first (only consulted with `reuseExisting`). */
  existing: ReadonlyMap<string, { id: string; name: string }>;
  takenNames: ReadonlySet<string>;
  /** How a built-in folder becomes a team: the same reader as a user's `.pibot` import. */
  read(pack: BuiltinPack): ResolvedTeam;
}
type Selection = Required<BuiltinSelection>;
type Bot = TeamTemplate["bots"][number];

export interface MergedTeam {
  plan: BuiltinPlan;
  /** One team built from all picked folders: each role once, groups without skipped members. */
  template: TeamTemplate;
  skills: TeamSkillPackage[][];
  reuse: Map<string, string>;
  skippedMembers: Map<number, string[]>;
  /** Built-in group id of each group in `template`, in order. */
  groupIds: string[];
}

/** Selections with every default filled in (the protocol schema applies the same defaults). */
export function fullSelection(selection: BuiltinSelection): Selection {
  return {
    groups: selection.groups ?? [],
    roles: selection.roles ?? [],
    professions: selection.professions ?? [],
    reuseExisting: selection.reuseExisting ?? false,
    duplicate: selection.duplicate ?? [],
  };
}

/**
 * The picked group and role folders combined into one team. A role used by
 * several picked groups (or also picked on its own) becomes one Bot that joins all of them; an
 * image role without an image model is skipped, and a group left with fewer than two members or
 * without its coordinator is not created. The same function runs for the preview and again
 * inside `builtin.create`, so the user gets exactly what the preview showed.
 */
export function mergeSelection(
  content: BuiltinContent,
  input: BuiltinSelection,
  context: PlanContext,
): MergedTeam {
  const selection = fullSelection(input);
  const unknown = [
    ...selection.groups.filter((id) => !content.groups.has(id)),
    ...selection.roles.filter((id) => !content.roles.has(id)),
    ...selection.professions.filter((id) => !content.professions.some((p) => p.id === id)),
  ];
  if (unknown.length) throw new RpcError(RpcErrorCodes.invalidParams, "builtin_unknown");
  const roles = new Map<string, { bot: Bot; skills: TeamSkillPackage[] }>();
  const remember = (team: ResolvedTeam) =>
    team.template.bots.forEach((bot, index) => {
      if (!roles.has(bot.ref)) roles.set(bot.ref, { bot, skills: team.skills[index] ?? [] });
    });
  const available = (ref: string) =>
    roles.get(ref)?.bot.category !== "image" || context.imageAvailable;
  const planGroups: BuiltinPlan["groups"] = [];
  const groups: TeamTemplate["groups"] = [];
  const groupIds: string[] = [];
  const skippedMembers = new Map<number, string[]>();
  for (const templateId of [...new Set(selection.groups)]) {
    const team = context.read(content.groups.get(templateId) as BuiltinPack);
    remember(team);
    const group = team.template.groups[0];
    if (!group) continue;
    const members = group.members.filter(available);
    const skipped = group.members.filter((ref) => !available(ref));
    const ok = members.length >= 2 && members.includes(group.coordinator);
    planGroups.push({
      templateId,
      name: group.name,
      coordinator: group.coordinator,
      members,
      skipped: skipped.map((roleId) => ({ roleId, reason: "no_image_model" as const })),
      announcement: group.announcement,
      available: ok,
    });
    if (!ok) continue;
    if (skipped.length)
      skippedMembers.set(
        groups.length,
        skipped.map((ref) => roles.get(ref)?.bot.role?.name ?? ref),
      );
    groups.push({ ...group, members });
    groupIds.push(templateId);
  }
  const order: string[] = [];
  const memberships = new Map<string, string[]>();
  for (const [index, group] of groups.entries())
    for (const ref of group.members) {
      if (!memberships.has(ref)) {
        memberships.set(ref, []);
        order.push(ref);
      }
      memberships.get(ref)?.push(groupIds[index] as string);
    }
  for (const roleId of selection.roles) {
    remember(context.read(content.roles.get(roleId) as BuiltinPack));
    if (!memberships.has(roleId)) {
      memberships.set(roleId, []);
      order.push(roleId);
    }
  }
  const duplicate = new Set(selection.duplicate);
  const reuse = new Map<string, string>();
  const takenNames = new Set(context.takenNames);
  const bots: BuiltinPlan["bots"] = order.map((roleId) => {
    const { bot } = roles.get(roleId) as { bot: Bot };
    const existing =
      selection.reuseExisting && !duplicate.has(roleId) ? context.existing.get(roleId) : undefined;
    if (existing && available(roleId)) reuse.set(roleId, existing.id);
    const name = existing ? existing.name : freeBotName(bot.name, takenNames);
    if (!existing && available(roleId)) takenNames.add(botNameKey(name));
    return {
      roleId,
      name,
      groups: memberships.get(roleId) ?? [],
      standalone: selection.roles.includes(roleId),
      ...(existing ? { existingBotId: existing.id, existingBotName: existing.name } : {}),
      ...(available(roleId) ? {} : { unavailable: "no_image_model" as const }),
    };
  });
  const kept = order.filter(available);
  return {
    plan: {
      groups: planGroups,
      bots,
      counts: {
        groups: groups.length,
        newBots: kept.filter((ref) => !reuse.has(ref)).length,
        maxGroups: BUILTIN_MAX_GROUPS,
        maxBots: BUILTIN_MAX_BOTS,
      },
    },
    template: {
      format: "pibot-team",
      version: 3,
      bots: kept.map((ref) => roles.get(ref)?.bot as Bot),
      groups,
    },
    skills: kept.map((ref) => roles.get(ref)?.skills ?? []),
    reuse,
    skippedMembers,
    groupIds,
  };
}
