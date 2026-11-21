import type { InboxItem } from "@pibot/protocol";
import { useNavigation, useT, useWorkspace } from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { GroupWorkflowDecisionCard } from "../../execution/GroupWorkflowDecisionCard.tsx";
import { MessageExecutionPause } from "../../execution/MessageExecutionPause.tsx";
import { GroupPlanCard } from "../../group/tasks/GroupPlanCard.tsx";
import styles from "./inbox.module.css";

/** The original plan RPC owns confirmation; an inbox item never becomes an approval grant. */
export function GroupPlanInboxCard({
  item,
  close,
}: {
  item: Extract<InboxItem, { kind: "group_plan" | "group_plan_action" }>;
  close(): void;
}) {
  const t = useT();
  const data = useWorkspace();
  const { navigate } = useNavigation();
  return (
    <article className={styles.card}>
      {item.kind === "group_plan_action" ? (
        <>
          <GroupWorkflowDecisionCard message={item.message} />
          <MessageExecutionPause message={item.message} />
        </>
      ) : (
        <GroupPlanCard
          message={{ id: item.messageId, usage: { groupPlan: item.card } }}
          bots={data.bots}
        />
      )}
      <div className={styles.links}>
        <Button
          variant="pill"
          onClick={() => {
            close();
            navigate({
              name: "chat",
              groupId: item.groupId,
              focus: { messageId: item.kind === "group_plan" ? item.messageId : item.message.id },
            });
          }}
        >
          {t(
            item.kind === "group_plan" && ["pending", "ready", "modify"].includes(item.card.status)
              ? "group.plan.modifyInChat"
              : "workspace.openChat",
          )}
        </Button>
      </div>
    </article>
  );
}
