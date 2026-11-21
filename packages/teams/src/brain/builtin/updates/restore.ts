/*
 * 「恢复上一版」: writes back what the last automatic update replaced, for one Bot or one
 * group, and marks that version as dismissed so the next start does not undo the decision.
 */
import { type Category, CategorySchema, type Level } from "@pibot/protocol";
import { BotsRepo, GroupsRepo, transaction } from "@pibot/storage";
import type { BuiltinChange } from "@pibot/teams-contract";
import { BuiltinBaselinesRepo, BuiltinRecoveriesRepo } from "../../../store/index.ts";
import { audit, type BuiltinUpdateDeps, missing, unavailable } from "./common.ts";

export async function restoreBot(
  deps: BuiltinUpdateDeps,
  signal: () => AbortSignal,
  botId: string,
): Promise<{ ok: true; failed: BuiltinChange[] }> {
  const recoveries = new BuiltinRecoveriesRepo(deps.db);
  const record = recoveries.bot(botId);
  if (!record) throw missing();
  const bot = new BotsRepo(deps.db).get(botId);
  if (!bot?.role) throw unavailable();
  const role = bot.role;
  const payload = record.payload;
  const failed: BuiltinChange[] = [];
  const step = async (what: BuiltinChange[], action: () => Promise<unknown>) => {
    try {
      await action();
    } catch {
      failed.push(...what);
    }
  };
  await step([{ item: "norms", action: "update" }], () =>
    deps.bots.update({ botId, norms: payload.norms, expectedNorms: bot.norms ?? "" }),
  );
  if (bot.thinkingLevel !== payload.thinkingLevel)
    await step([{ item: "thinking", action: "update" }], () =>
      deps.bots.update({ botId, thinkingLevel: payload.thinkingLevel }),
    );
  const levels: Partial<Record<Category, Level | null>> = {};
  for (const category of CategorySchema.options) {
    const next = (payload.permissionOverrides[category] as Level | undefined) ?? null;
    if ((bot.permissionOverrides?.[category] ?? null) !== next) levels[category] = next;
  }
  if (Object.keys(levels).length)
    await step([{ item: "permission", action: "update" }], () =>
      deps.permissions.set({ botId, levels }),
    );
  const rows = await deps.skills().inventory(botId, signal(), { skipSharedContent: true });
  const byFolder = new Map(
    rows.filter((row) => row.source === "team").map((row) => [row.folder, row]),
  );
  for (const skill of payload.skills) {
    const row = byFolder.get(skill.folder);
    const files = skill.files.map((file) => ({
      path: file.path,
      data: Buffer.from(file.data, "base64"),
      text: file.text,
      script: file.script,
    }));
    await step(
      [{ item: "skill", action: row ? "update" : "add", name: skill.document.name }],
      () =>
        row
          ? deps.skills().replace(botId, row.id, skill.document, files)
          : deps.skills().create(botId, skill.document, "team", {
              enabled: skill.enabled,
              files,
              folder: skill.folder,
            }),
    );
  }
  const keep = new Set(payload.skills.map((skill) => skill.folder));
  for (const [folder, row] of byFolder)
    if (!keep.has(folder))
      await step([{ item: "skill", action: "remove", name: row.name }], () =>
        deps.skills().remove(botId, row.id),
      );
  const fromVersion = Math.max(1, record.fromVersion);
  transaction(deps.db, () => {
    new BotsRepo(deps.db).update(botId, { role: { id: role.id, version: fromVersion } });
    recoveries.clear("bot", botId);
    // A restored version is a decision, not an older Bot: the next start must not undo it.
    new BuiltinBaselinesRepo(deps.db).dismissBot(botId, record.toVersion, {
      sourceId: role.id,
      version: fromVersion,
    });
    audit(
      deps,
      botId,
      { reasonCode: "restored", target: `${role.id}@${record.toVersion}` },
      "Built-in role update undone / 已恢复上一版",
    );
  });
  deps.peer.emit("bots.changed", { botId, reason: "updated" });
  return { ok: true as const, failed };
}

export async function restoreGroup(
  deps: BuiltinUpdateDeps,
  _signal: () => AbortSignal,
  groupId: string,
): Promise<{ ok: true; failed: BuiltinChange[] }> {
  const recoveries = new BuiltinRecoveriesRepo(deps.db);
  const record = recoveries.group(groupId);
  if (!record) throw missing();
  const group = new GroupsRepo(deps.db).get(groupId);
  if (!group) throw unavailable();
  const failed: BuiltinChange[] = [];
  try {
    await deps.groups.update({
      groupId,
      announcement: record.payload.announcement,
      autoRoundLimit: record.payload.autoRoundLimit,
    });
  } catch {
    failed.push(
      { item: "announcement", action: "update" },
      { item: "roundLimit", action: "update" },
    );
  }
  transaction(deps.db, () => {
    recoveries.clear("group", groupId);
    new BuiltinBaselinesRepo(deps.db).dismissGroup(groupId, record.toVersion, {
      sourceId: record.sourceId,
      version: Math.max(0, record.fromVersion),
    });
    audit(
      deps,
      group.coordinatorBotId,
      {
        groupId,
        reasonCode: "restored",
        target: `${record.sourceId}@${record.toVersion}`,
      },
      "Group template update undone / 已恢复上一版",
    );
  });
  deps.peer.emit("groups.changed", { groupId, reason: "updated" });
  return { ok: true as const, failed };
}
