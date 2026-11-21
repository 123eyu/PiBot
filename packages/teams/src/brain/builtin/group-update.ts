import { textFingerprint } from "@pibot/brain/kit";
import type { Bot, Group } from "@pibot/protocol";
import type { BuiltinChange } from "@pibot/teams-contract";
import type { GroupBaseline, Stored } from "../../store/index.ts";
import type { BuiltinHistory, GroupFingerprint } from "./history.ts";
import type { BuiltinContent } from "./load.ts";

type Language = "zh" | "en";
type Provenance = "recorded" | "history" | "none";

/** Which template (and version) a group came from. */
export interface GroupOrigin {
  templateId: string;
  version: number;
  provenance: Provenance;
  language?: Language;
  baseline?: GroupBaseline;
  dismissedVersion: number | null;
}

const hashes = (variants: GroupFingerprint[], pick: (v: GroupFingerprint) => [string, string]) =>
  new Set(variants.flatMap(pick));

/**
 * Groups made before provenance was stored carry no template mark. One is recognised as a
 * template's when its coordinator Bot comes from the template's coordinator role (role marks
 * are real provenance) and its name is the template's name, possibly numbered「 (2)」. The
 * version is the newest one whose announcement it still has; otherwise unknown (0), and every
 * field is treated as changed by the user.
 */
export function groupOrigin(
  group: Group,
  coordinatorRole: string | undefined,
  content: BuiltinContent,
  stored: Stored<GroupBaseline> | undefined,
): GroupOrigin | undefined {
  if (stored && content.groups.has(stored.sourceId)) {
    const variants = content.history?.groups[stored.sourceId]?.[String(stored.version)] ?? [];
    return {
      templateId: stored.sourceId,
      version: stored.version,
      provenance: stored.baseline ? "recorded" : variants.length ? "history" : "none",
      ...(stored.baseline ? { baseline: stored.baseline, language: stored.baseline.language } : {}),
      dismissedVersion: stored.dismissedVersion,
    };
  }
  const history = content.history;
  if (!history || !coordinatorRole) return undefined;
  const name = group.name.replace(/ \(\d+\)$/, "");
  const announcement = textFingerprint(group.announcement);
  for (const [templateId, versions] of Object.entries(history.groups)) {
    if (!content.groups.has(templateId)) continue;
    const all = Object.entries(versions);
    const matches = all.some(([, variants]) =>
      variants.some(
        (v) => (v.name.zh === name || v.name.en === name) && v.coordinator === coordinatorRole,
      ),
    );
    if (!matches) continue;
    let found: { version: number; language: Language } | undefined;
    for (const [version, variants] of all)
      for (const v of variants) {
        const language =
          v.announcement.zh === announcement
            ? "zh"
            : v.announcement.en === announcement
              ? "en"
              : undefined;
        if (language && (!found || Number(version) > found.version))
          found = { version: Number(version), language };
      }
    return {
      templateId,
      version: found?.version ?? 0,
      provenance: found ? "history" : "none",
      ...(found ? { language: found.language } : {}),
      dismissedVersion: null,
    };
  }
  return undefined;
}

export interface GroupPlan {
  origin: GroupOrigin;
  language: Language;
  toVersion: number;
  changes: BuiltinChange[];
  kept: BuiltinChange[];
  patch: { announcement?: string; autoRoundLimit?: number };
  /** Coordinator changes require explicit adoption, including any required member addition. */
  coordinatorAdoption: boolean;
  coordinatorRole?: string;
  /** New template members the group lacks, with an active Bot of that role outside the group. */
  members: { roleId: string; name: string; existingBotId?: string; existingBotName?: string }[];
  quickStarts: string[];
  revision: string;
  baseline: GroupBaseline;
}

export interface GroupPlanInput {
  group: Group;
  bots: ReadonlyMap<string, Bot>;
  origin: GroupOrigin;
  content: BuiltinContent;
  history?: BuiltinHistory;
  /** Newest active Bot of each role (outside this group or not), for offering a reuse. */
  existing: ReadonlyMap<string, { id: string; name: string }>;
  language: Language;
  redact(text: string): string;
  /** An automatic update replaces the announcement and round limit even when edited. */
  force?: boolean;
}

/**
 * For a group made from a template: the announcement and the round limit follow the new
 * version while they still hold the old one; new members are only offered (the user picks);
 * members the new version dropped stay. Quick starts live in the welcome message, so they are
 * shown, not rewritten. Local computation only.
 */
export function planGroupUpdate(input: GroupPlanInput): GroupPlan {
  const { group, origin, content } = input;
  const force = input.force === true;
  const pack = content.groups.get(origin.templateId);
  const language = origin.language ?? input.language;
  const template = pack?.[language].template.groups[0];
  if (!pack || !template?.template) throw new TypeError("unknown template");
  const variants =
    origin.provenance === "history"
      ? (input.history?.groups[origin.templateId]?.[String(origin.version)] ?? [])
      : [];
  const recorded = origin.baseline;
  const old = {
    announcement: recorded
      ? new Set([recorded.announcement])
      : hashes(variants, (v) => [v.announcement.zh, v.announcement.en]),
    rounds: new Set(recorded ? [recorded.autoRoundLimit] : variants.map((v) => v.autoRoundLimit)),
    quickStarts: recorded
      ? new Set([recorded.quickStarts])
      : hashes(variants, (v) => [v.quickStarts.zh, v.quickStarts.en]),
  };
  const reason = origin.provenance === "none" ? "unknown" : "changed";
  const changes: BuiltinChange[] = [];
  const kept: BuiltinChange[] = [];
  const patch: GroupPlan["patch"] = {};
  const prior = input.history?.groups[origin.templateId]?.[String(origin.version)] ?? [];
  const currentCoordinator = input.bots.get(group.coordinatorBotId);
  const coordinatorAdoption =
    origin.provenance === "none" ||
    currentCoordinator?.role?.id !== template.coordinator ||
    prior.some((v) => v.coordinator !== template.coordinator);
  const coordinatorUnchanged = recorded?.coordinatorBotId
    ? recorded.coordinatorBotId === group.coordinatorBotId
    : prior.some((v) => v.coordinator === currentCoordinator?.role?.id);
  const coordinatorRole =
    coordinatorAdoption &&
    coordinatorUnchanged &&
    currentCoordinator?.role?.id !== template.coordinator
      ? template.coordinator
      : undefined;
  if (coordinatorAdoption && currentCoordinator?.role?.id !== template.coordinator) {
    (coordinatorRole ? changes : kept).push({
      item: "coordinator",
      action: coordinatorRole ? "update" : "keep",
      name: coordinatorRole
        ? (pack[language].template.bots.find((bot) => bot.ref === template.coordinator)?.role
            ?.name ?? template.coordinator)
        : currentCoordinator?.name,
      ...(!coordinatorRole ? { reason } : {}),
    });
  }
  const nextAnnouncement = input.redact(template.announcement);
  const current = textFingerprint(group.announcement);
  if (current !== textFingerprint(nextAnnouncement)) {
    if (
      (!coordinatorAdoption && force) ||
      (old.announcement.has(current) && (coordinatorUnchanged || !coordinatorAdoption))
    ) {
      changes.push({ item: "announcement", action: "update" });
      patch.announcement = nextAnnouncement;
    } else kept.push({ item: "announcement", action: "keep", reason });
  }
  if (group.autoRoundLimit !== template.autoRoundLimit) {
    const line = {
      item: "roundLimit",
      from: String(group.autoRoundLimit),
      to: String(template.autoRoundLimit),
    } as const;
    if (force || old.rounds.has(group.autoRoundLimit)) {
      changes.push({ ...line, action: "update" });
      patch.autoRoundLimit = template.autoRoundLimit;
    } else kept.push({ ...line, action: "keep", reason });
  }
  const roles = new Map<string, Bot>();
  for (const member of group.members) {
    const bot = input.bots.get(member.botId);
    if (bot?.role) roles.set(bot.role.id, bot);
  }
  const roleName = (roleId: string) =>
    pack[language].template.bots.find((bot) => bot.ref === roleId)?.role?.name ?? roleId;
  const members = template.members
    .filter((roleId) => !roles.has(roleId))
    .map((roleId) => {
      const existing = input.existing.get(roleId);
      return {
        roleId,
        name: roleName(roleId),
        ...(existing ? { existingBotId: existing.id, existingBotName: existing.name } : {}),
      };
    });
  for (const [roleId, bot] of roles)
    if (!template.members.includes(roleId))
      kept.push({ item: "member", action: "keep", name: bot.name, reason: "dropped" });
  const quickStartsHash = textFingerprint(JSON.stringify(template.quickStarts ?? []));
  const quickStarts = old.quickStarts.has(quickStartsHash) ? [] : (template.quickStarts ?? []);
  const toVersion = template.template.version;
  return {
    origin,
    language,
    toVersion,
    changes,
    kept,
    patch,
    coordinatorAdoption,
    ...(coordinatorRole ? { coordinatorRole } : {}),
    members,
    quickStarts,
    revision: textFingerprint(
      JSON.stringify({
        to: toVersion,
        changes,
        kept,
        members,
        announcement: current,
        rounds: group.autoRoundLimit,
        roster: group.members.map((member) => member.botId),
        coordinator: group.coordinatorBotId,
      }),
    ),
    baseline: {
      language,
      announcement: textFingerprint(nextAnnouncement),
      autoRoundLimit: template.autoRoundLimit,
      members: template.members,
      quickStarts: quickStartsHash,
    },
  };
}
