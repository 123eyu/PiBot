import type { ChatPeer } from "@pibot/client-core";
import type { Workplaces } from "@pibot/protocol";
import { AppSelect, BotAvatar, useAction, useT, useWorkspace, waitRpc } from "@pibot/renderer-kit";
import { Button, Icon, IconTile } from "@pibot/ui";
import { useCallback, useEffect, useState } from "react";
import type { GroupSnapshot } from "../data.ts";
import styles from "../group.module.css";
import { MemberOverview } from "./MemberOverview.tsx";

export function GroupMembers({
  peer,
  data,
  refresh,
  places,
}: {
  peer: ChatPeer;
  data: GroupSnapshot;
  refresh(): Promise<void>;
  places?: Map<string, Workplaces>;
}) {
  const t = useT();
  const catalog = useWorkspace();
  const action = useAction();
  const [selected, setSelected] = useState("");
  const [removing, setRemoving] = useState<string>();
  const [viewing, setViewing] = useState<string>();
  const [notice, setNotice] = useState(false);
  const unavailable = useCallback(() => {
    setViewing(undefined);
    setNotice(true);
  }, []);
  const group = data.group;
  const member = data.bots.find((bot) => bot.id === viewing);
  useEffect(() => {
    if (
      viewing &&
      (!group?.members.some((m) => m.botId === viewing) ||
        member?.archivedAt ||
        (!member && data.membersReady && !data.error))
    )
      unavailable();
  }, [viewing, group, member, data.membersReady, data.error, unavailable]);
  if (!group) return null;
  const candidates = catalog.bots.filter(
    (bot) => !bot.archivedAt && !group.members.some((m) => m.botId === bot.id),
  );
  const mutate = async (botId: string, remove: boolean) => {
    if (!data.identityReady || !data.membersReady || data.error) return;
    const result = await action.run(
      (signal) =>
        waitRpc(
          () =>
            peer.call(remove ? "groups.removeMember" : "groups.addMember", {
              groupId: group.id,
              botId,
            }),
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        ),
      () => "group.saveFailed",
    );
    if (result?.id === group.id) {
      setRemoving(undefined);
      setSelected("");
      await refresh();
    }
  };
  if (viewing && member && group.members.some((m) => m.botId === viewing) && !member.archivedAt)
    return (
      <MemberOverview
        key={viewing}
        peer={peer}
        group={group}
        bot={member}
        places={places}
        back={() => setViewing(undefined)}
        unavailable={unavailable}
      />
    );
  return (
    <div className={styles.stack}>
      <p className={styles.note}>{t("group.membersNote")}</p>
      {!!group.folders?.length && <p className={styles.note}>{t("group.workspaceHelp")}</p>}
      {notice && (
        <p role="status" className={styles.note}>
          {t("group.memberUnavailable")}
        </p>
      )}
      <div className={styles.memberList}>
        {group.members.map(({ botId }) => {
          const bot = data.bots.find((b) => b.id === botId);
          const name = bot?.name ?? t("group.member");
          const workspace = group.memberWorkspaces?.find((w) => w.botId === botId);
          const protectedMember =
            botId === group.coordinatorBotId ||
            (group.workplace.kind === "folder" && group.workplace.botId === botId);
          return (
            <div
              key={botId}
              className={styles.member}
              data-coordinator={botId === group.coordinatorBotId || undefined}
            >
              <button
                type="button"
                className={styles.memberOpen}
                aria-label={t("group.openMember", { name })}
                disabled={!bot || !!bot.archivedAt}
                onClick={() => {
                  setViewing(botId);
                  setNotice(false);
                  setRemoving(undefined);
                }}
              >
                <BotAvatar bot={bot} unknown label={name} size={44} />
                <span className={styles.memberName}>
                  <strong>{name}</strong>
                  <small>
                    {workspace
                      ? t(`group.workspace.${workspace.state}`)
                      : t(
                          botId === group.coordinatorBotId
                            ? "group.coordinator"
                            : "group.memberRole",
                        )}
                  </small>
                </span>
                <Icon name="chevronRight" size={14} />
              </button>
              {/* The coordinator (and the folder's owner) cannot be removed, so no button. */}
              {!protectedMember && (
                <Button
                  variant="ghost"
                  className={styles.memberRemove}
                  aria-label={t("group.removeMember", { name })}
                  disabled={action.busy || group.members.length <= 2 || data.error}
                  onClick={() => setRemoving(botId)}
                >
                  <Icon name="close" size={14} />
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {removing && (
        <fieldset className={styles.confirm} aria-label={t("group.confirm")}>
          <IconTile icon="trash" tone="red" />
          <p>
            {t("group.removeConfirm", {
              name: data.bots.find((b) => b.id === removing)?.name ?? removing,
            })}
          </p>
          <Button
            variant="primary"
            loading={action.busy}
            onClick={() => void mutate(removing, true)}
          >
            {t("group.confirm")}
          </Button>
          <Button variant="ghost" disabled={action.busy} onClick={() => setRemoving(undefined)}>
            {t("common.cancel")}
          </Button>
        </fieldset>
      )}
      <form
        className={styles.memberAdd}
        aria-label={t("group.chooseMember")}
        onSubmit={(e) => {
          e.preventDefault();
          if (candidates.some((b) => b.id === selected)) void mutate(selected, false);
        }}
      >
        <AppSelect
          hideLabel
          label={t(
            candidates.length
              ? "group.chooseMember"
              : catalog.hasMoreBots
                ? "group.loadMemberOptions"
                : "group.noCandidates",
          )}
          value={candidates.some((bot) => bot.id === selected) ? selected : ""}
          disabled={action.busy || group.members.length >= 6 || !candidates.length || data.error}
          change={setSelected}
          options={candidates.map((bot) => ({ value: bot.id, label: bot.name }))}
        />
        <Button
          type="submit"
          variant="pill"
          className={styles.memberJoin}
          disabled={
            !candidates.some((b) => b.id === selected) ||
            action.busy ||
            group.members.length >= 6 ||
            data.error
          }
        >
          {t("group.join")}
        </Button>
      </form>
      {catalog.hasMoreBots && (
        <Button variant="ghost" disabled={action.busy} onClick={() => void catalog.moreBots()}>
          {t("group.moreMembers")}
        </Button>
      )}
      {action.error && (
        <p role="alert" className={styles.error}>
          {t(action.error)}
        </p>
      )}
    </div>
  );
}
