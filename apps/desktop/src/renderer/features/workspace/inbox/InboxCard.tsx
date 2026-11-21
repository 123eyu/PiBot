import type { InboxItem, Memory } from "@pibot/protocol";
import {
  locateConversation,
  useAction,
  useNavigation,
  useRpc,
  useSettings,
  useWorkspace,
} from "@pibot/renderer-kit";
import { RoutineProposalInbox } from "@pibot/routines/ui";
import { Button } from "@pibot/ui";
import type { ComponentProps } from "react";
import { ApprovalCard } from "../../chat/tools/ApprovalCard.tsx";
import { UserQuestionCard } from "../../execution/UserQuestionCard.tsx";
import { MemoryProposalReview } from "../memory/MemoryProposalReview.tsx";
import { memoryError } from "../memory/memory-notices.ts";
import { BackgroundTaskInboxCard } from "./BackgroundTaskInboxCard.tsx";
import { ConnectorAuthInbox } from "./ConnectorAuthInbox.tsx";
import { GroupPlanInboxCard } from "./GroupPlanInboxCard.tsx";
import { HandoffInboxCard } from "./HandoffInboxCard.tsx";
import { InboxOriginCard } from "./InboxOriginCard.tsx";
import styles from "./inbox.module.css";
import { PersonalTodoCard } from "./PersonalTodoCard.tsx";
import { RoutineInboxCard } from "./RoutineInboxCard.tsx";
import type { InboxDisplayItem } from "./use-inbox.ts";

export function InboxCard(props: ComponentProps<typeof InboxCardBody>) {
  return (
    <InboxOriginCard item={props.item} close={props.close}>
      <InboxCardBody {...props} />
    </InboxOriginCard>
  );
}

function InboxCardBody({
  item,
  close,
  refresh,
  record,
  forget,
  memories,
  memoriesLoading,
}: {
  item: InboxDisplayItem;
  close(): void;
  refresh(): Promise<void>;
  record(item: InboxItem): void;
  forget?(cursor: string): void;
  memories?: Memory[];
  memoriesLoading: boolean;
}) {
  const { peer } = useRpc();
  const { t } = useSettings();
  const data = useWorkspace();
  const task = useAction();
  const { navigate, openSettings, openWorkspace } = useNavigation();
  if (item.kind === "user_question")
    return <UserQuestionCard inbox message={item.message} pause={item.pause} />;
  if (item.kind === "group_plan" || item.kind === "group_plan_action")
    return <GroupPlanInboxCard item={item} close={close} />;
  if (item.kind === "personal_todo")
    return (
      <PersonalTodoCard
        removed={() => forget?.(item.cursor)}
        todo={item.todo}
        refresh={refresh}
        record={(todo) => record({ ...item, todo })}
      />
    );
  if (item.kind === "connector_auth") return <ConnectorAuthInbox item={item} refresh={refresh} />;
  if (item.kind === "background_task") return <BackgroundTaskInboxCard item={item} />;
  if (item.kind === "routine_proposal")
    return <RoutineProposalInbox item={item} close={close} record={record} />;
  if (item.kind === "computer_handoff") return <HandoffInboxCard item={item} close={close} />;
  if (
    item.kind === "routine_approval" ||
    item.kind === "routine_missed" ||
    item.kind === "routines_paused_away" ||
    item.kind === "routine_trigger_error"
  )
    return <RoutineInboxCard item={item} refresh={refresh} record={record} />;
  if (item.kind !== "approval" && item.kind !== "memory" && item.kind !== "provider") return null;
  const botId =
    item.kind === "approval"
      ? item.approval.botId
      : item.kind === "memory"
        ? item.proposal.botId
        : undefined;
  const bot = data.bots.find((bot) => bot.id === botId);
  const name = bot?.name ?? t("workspace.botUnknown");
  const conversationId = item.kind === "provider" ? undefined : item.conversationId;
  const title =
    item.kind === "approval"
      ? t(`workspace.inboxAction.${item.approval.category}`, { name })
      : item.kind === "memory"
        ? t("workspace.inboxMemory", { name })
        : t("workspace.inboxProvider", { name: item.providerId });
  const open = () => {
    if (item.kind === "provider") {
      openSettings("models");
      return;
    }
    if (!conversationId) {
      close();
      openWorkspace({
        name: "profile",
        botId: item.kind === "approval" ? item.approval.botId : item.proposal.botId,
        target: item.kind === "approval" ? "permissions" : "memory",
      });
      return;
    }
    if (peer)
      void task
        .run((signal) =>
          locateConversation(
            peer,
            conversationId,
            AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            data.bots,
            data.groups,
            botId,
          ),
        )
        .then((target) => {
          if (target) {
            close();
            navigate(target);
          }
        });
  };
  return (
    <article className={styles.card} aria-label={title}>
      <header className={styles.cardHeader}>
        <div className={styles.heading}>
          <strong>{title}</strong>
        </div>
        <span className={styles.badge}>
          {t(
            item.kind === "approval"
              ? "workspace.approval"
              : item.kind === "memory"
                ? "workspace.memory"
                : "workspace.reauth",
          )}
        </span>
      </header>
      {item.kind === "approval" ? (
        <div className={styles.approvalBody}>
          <ApprovalCard
            inbox
            conversationId={item.conversationId}
            approval={item.approval}
            refresh={refresh}
            decide={async (id, decision, remember, preauthorize, rememberSecrets) => {
              if (!peer) throw new Error("Disconnected");
              const approval = item.approval;
              await peer.call("approvals.resolve", {
                id,
                decision,
                preauthorize,
                remember: approval.rememberOnly === "secrets" ? false : remember,
                ...(decision === "allow" &&
                approval.canRememberSecrets === true &&
                approval.source !== "routine" &&
                !approval.routineRunId &&
                approval.risk !== "danger" &&
                rememberSecrets?.length &&
                rememberSecrets.every((name) => /^[A-Z][A-Z0-9_]{0,63}$/.test(name))
                  ? { rememberSecrets }
                  : {}),
              });
            }}
          />
        </div>
      ) : item.kind === "memory" ? (
        item.proposal.status === "pending" ? (
          <div className={styles.memoryBody}>
            <MemoryProposalReview
              proposal={item.proposal}
              memories={memories}
              loading={memoriesLoading}
              busy={task.busy}
              retry={() => void refresh()}
              resolve={(accept) => {
                if (peer)
                  void task
                    .run(
                      () => peer.call("memory.resolve", { proposalId: item.proposal.id, accept }),
                      memoryError,
                    )
                    .then((result) => {
                      if (
                        result &&
                        result.proposal.id === item.proposal.id &&
                        result.proposal.botId === item.proposal.botId
                      ) {
                        record({ ...item, proposal: result.proposal });
                        void refresh();
                        void data.refresh();
                      }
                    });
              }}
            />
          </div>
        ) : (
          <p className={styles.result} role="status">
            {t(
              item.proposal.status === "accepted"
                ? `workspace.memoryApplied.${item.proposal.action}`
                : "workspace.memoryRejected",
            )}
          </p>
        )
      ) : item.providerConnected ? (
        <p className={styles.result} role="status">
          {t("workspace.reauthDone")}
        </p>
      ) : (
        <dl className={styles.providerFacts}>
          <div>
            <dt>{t("workspace.provider")}</dt>
            <dd>{item.providerId}</dd>
          </div>
          <div>
            <dt>{t("workspace.state")}</dt>
            <dd>{t("workspace.reauthNote")}</dd>
          </div>
        </dl>
      )}
      {!conversationId && (
        <div className={styles.links}>
          <Button variant="pill" disabled={task.busy} onClick={open}>
            {t(
              item.kind === "provider"
                ? item.providerConnected
                  ? "settings.models"
                  : "workspace.reauth"
                : conversationId
                  ? "workspace.openChat"
                  : "workspace.profile",
            )}
          </Button>
        </div>
      )}
      {task.error && (
        <p className={styles.error} role="alert">
          {t(task.error === "workspace.createUncertain" ? "workspace.actionUncertain" : task.error)}
        </p>
      )}
    </article>
  );
}
