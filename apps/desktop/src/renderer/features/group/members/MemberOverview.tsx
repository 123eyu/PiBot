import type { ChatPeer } from "@pibot/client-core";
import { type Bot, CategorySchema, type Group, type Workplaces } from "@pibot/protocol";
import { BotAvatar, useNavigation, useT } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import styles from "../group.module.css";
import { useMemberOverview } from "./use-member-overview.ts";

export function MemberOverview({
  peer,
  group,
  bot,
  places: _places,
  back,
  unavailable,
}: {
  peer: ChatPeer;
  group: Group;
  bot: Bot;
  places?: Map<string, Workplaces>;
  back(): void;
  unavailable(): void;
}) {
  const t = useT();
  const { openBotPanel } = useNavigation();
  const state = useMemberOverview(peer, group.id, bot.id, unavailable);
  const data = state.data;
  const member = data?.bot ?? bot;
  const workspace = group.memberWorkspaces?.find((w) => w.botId === bot.id);
  const coordinator = member.id === group.coordinatorBotId;
  const role = t(coordinator ? "group.coordinator" : "group.memberRole");
  const missing = t(data ? "group.overviewUnknown" : "common.loading");
  const levels = data?.permissions?.effective?.levels;
  const permissions =
    levels &&
    CategorySchema.options
      .map(
        (category) =>
          `${t(`permissions.category.${category}`)} ${t(`group.permission.${levels[category]}`)}`,
      )
      .join(" · ");
  const counts = data?.counts;
  return (
    <div className={styles.stack}>
      <Button variant="ghost" className={styles.memberBack} onClick={back}>
        {t("group.backMembers")}
      </Button>
      <div className={styles.memberCard}>
        <span className={styles.memberCardAvatar} data-coordinator={coordinator || undefined}>
          <BotAvatar bot={member} label={member.name} size={52} />
        </span>
        <strong>{member.name}</strong>
        <small className={styles.memberCardRole}>
          {role}
          {member.description ? ` · ${member.description}` : ""}
        </small>
      </div>
      <dl className={styles.memberFacts}>
        <dt>{t("workspace.model")}</dt>
        <dd>
          {!member.modelProvider || !member.modelId
            ? t("group.memberNoModel")
            : (data?.model ?? missing)}
        </dd>
        {workspace && (
          <>
            <dt>{t("group.workspaceLabel")}</dt>
            <dd title={workspace.path}>
              {t(`group.workspace.${workspace.state}`)}
              <br />
              {workspace.path}
            </dd>
          </>
        )}
        <dt>{t("group.integrationWorkspace")}</dt>
        <dd>
          {group.folders?.length
            ? t("group.memberGroupFolder", {
                path: group.folders.map((f) => f.displayPath).join(" · "),
              })
            : t("folders.groupHome")}
        </dd>
        <dt>{t("group.memberPermissions")}</dt>
        <dd>{permissions ?? missing}</dd>
        <dt>{t("group.memberMemory")}</dt>
        <dd>
          {data?.memoryCount === undefined
            ? missing
            : t("group.memberMemoryCount", { count: data.memoryCount })}
        </dd>
        <dt>{t("group.memberInGroup")}</dt>
        <dd>
          {!counts
            ? missing
            : coordinator
              ? t("group.memberAssigned", { count: counts.assigned })
              : t("group.memberTaskCounts", { count: counts.total, open: counts.open })}
        </dd>
      </dl>
      {data?.error && (
        <p role="alert" className={styles.note}>
          {t("group.overviewFailed")}{" "}
          <Button variant="pill" onClick={state.retry}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      <div className={styles.memberEdit}>
        <Button variant="pill" onClick={() => openBotPanel(member.id, "details")}>
          {t("group.editMemberProfile", { name: member.name })}
        </Button>
        <p className={styles.note}>{t("group.editMemberHelp", { name: member.name })}</p>
      </div>
    </div>
  );
}
