import { PendingImportedSkills, TargetConnections } from "@pibot/plugins/ui";
import { AppSelect, BotAvatar, botPanelStyles as panelStyles, useT } from "@pibot/renderer-kit";
import { SkillsSection } from "@pibot/skills/ui";
import { IconTile } from "@pibot/ui";
import { useState } from "react";
import { MemorySummary } from "../../workspace/memory/MemorySummary.tsx";
import type { GroupSnapshot } from "../data.ts";

// The pending list refreshes itself on `plugins.changed`; nothing here needs telling.
const settled = () => undefined;

/** Group 「技能」 tab: the member picker, that member's skills here, the group's connections and memory. */
export function GroupResources({ data }: { data: GroupSnapshot }) {
  const t = useT();
  const [chosen, setChosen] = useState("");
  const group = data.group;
  if (!group) return null;
  const members = data.bots.filter(
    (bot) => !bot.archivedAt && group.members.some((member) => member.botId === bot.id),
  );
  const member =
    members.find((bot) => bot.id === chosen) ??
    members.find((bot) => bot.id === group.coordinatorBotId) ??
    members[0];
  return (
    <div className={panelStyles.stack}>
      <p className={panelStyles.note}>{t("group.resourcesIsolation")}</p>
      <section className={panelStyles.section} aria-label={t("group.memberSkills")}>
        <h2>{t("group.memberSkills")}</h2>
        <div className={panelStyles.card}>
          <div className={panelStyles.cardRow}>
            {member ? (
              <BotAvatar bot={member} label={member.name} size={28} />
            ) : (
              <IconTile icon="user" tone="teal" size="lg" />
            )}
            <span className={panelStyles.rowText}>
              <strong>{t("group.skillMember")}</strong>
              <small>{t("group.memberSkillsHint")}</small>
            </span>
            <AppSelect
              variant="pill"
              hideLabel
              label={t("group.skillMember")}
              value={member?.id ?? ""}
              options={members.map((bot) => ({ value: bot.id, label: bot.name }))}
              change={setChosen}
              disabled={!data.membersReady || data.error}
            />
          </div>
        </div>
      </section>
      {/* Siblings of the picker, so every section of the tab gets the panel's one spacing. */}
      {member && data.membersReady && !data.error && (
        <SkillsSection
          key={`${group.id}:${member.id}`}
          groupId={group.id}
          botId={member.id}
          botName={member.name}
          archived={false}
          allowWorkflowRun={member.category !== "image"}
          pendingImports={<PendingImportedSkills changed={settled} />}
        />
      )}
      <TargetConnections key={`connections:${group.id}`} target={{ kind: "group", id: group.id }} />
      <GroupMemory key={group.id} groupId={group.id} />
    </div>
  );
}
function GroupMemory({ groupId }: { groupId: string }) {
  const t = useT();
  return (
    <section className={panelStyles.section} aria-label={t("group.sharedMemory")}>
      <h2>{t("group.sharedMemory")}</h2>
      <MemorySummary owner={{ scope: "group", ownerId: groupId }} />
    </section>
  );
}
