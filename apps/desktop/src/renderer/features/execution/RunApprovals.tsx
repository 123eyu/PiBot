import { useRpc, useT } from "@pibot/renderer-kit";
import { ApprovalCard } from "../chat/tools/ApprovalCard.tsx";
import { useLocalActivity } from "../chat/tools/local-activity.ts";

/** Reuses the chat approval owner; a task view never creates or copies an approval. */
export function RunApprovals({
  botId,
  conversationId,
  runId,
  context,
}: {
  botId: string;
  conversationId: string;
  runId?: string;
  context?: { botName: string; groupName: string };
}) {
  const { peer } = useRpc();
  return peer ? (
    <PendingApprovals
      peer={peer}
      botId={botId}
      conversationId={conversationId}
      runId={runId}
      context={context}
    />
  ) : null;
}

function PendingApprovals({
  peer,
  botId,
  conversationId,
  runId,
  context,
}: {
  peer: NonNullable<ReturnType<typeof useRpc>["peer"]>;
  botId: string;
  conversationId: string;
  runId?: string;
  context?: { botName: string; groupName: string };
}) {
  const t = useT();
  const activity = useLocalActivity(peer, botId);
  return (
    <>
      {activity.state.error && <p role="alert">{t("execution.loadError")}</p>}
      {activity.state.approvals
        .filter(
          (approval) =>
            approval.status === "pending" &&
            approval.botId === botId &&
            approval.conversationId === conversationId &&
            (!runId || approval.runId === runId),
        )
        .map(
          (approval) =>
            activity.decide && (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                conversationId={conversationId}
                refresh={activity.refresh}
                decide={activity.decide}
                context={context}
              />
            ),
        )}
    </>
  );
}
