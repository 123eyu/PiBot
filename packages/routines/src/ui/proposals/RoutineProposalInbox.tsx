import type { InboxItem, RoutineProposal } from "@pibot/protocol";
import {
  locateConversation,
  useAction,
  useNavigation,
  useRpc,
  useT,
  useWorkspace,
} from "@pibot/renderer-kit";
import { Button } from "@pibot/ui";
import { useCallback } from "react";
import { RoutineProposalCard } from "./RoutineProposalCard.tsx";

export function RoutineProposalInbox({
  item,
  close,
  record,
}: {
  item: Extract<InboxItem, { kind: "routine_proposal" }>;
  close(): void;
  record(item: InboxItem): void;
}) {
  const { peer } = useRpc();
  const t = useT();
  const data = useWorkspace();
  const { navigate } = useNavigation();
  const action = useAction();
  const resolved = useCallback(
    (proposal: RoutineProposal) => record({ ...item, proposal }),
    [item, record],
  );
  return (
    <article>
      <RoutineProposalCard proposal={item.proposal} resolved={resolved} />
      {item.conversationId && (
        <Button
          variant="pill"
          disabled={action.busy || !peer}
          onClick={() => {
            if (!peer || !item.conversationId) return;
            void action
              .run((signal) =>
                locateConversation(
                  peer,
                  item.conversationId as string,
                  AbortSignal.any([signal, AbortSignal.timeout(30000)]),
                  data.bots,
                  data.groups,
                  item.proposal.botId,
                ),
              )
              .then((target) => {
                if (target) {
                  close();
                  navigate({
                    ...target,
                    ...(item.origin?.messageId
                      ? { focus: { messageId: item.origin.messageId } }
                      : {}),
                  });
                }
              });
          }}
        >
          {t("workspace.openChat")}
        </Button>
      )}
      {action.error && <p role="alert">{t(action.error)}</p>}
    </article>
  );
}
