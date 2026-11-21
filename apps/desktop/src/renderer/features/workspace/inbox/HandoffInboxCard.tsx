import { ComputerHandoffInbox } from "@pibot/computer-use/ui";
import type { InboxItem } from "@pibot/protocol";
import {
  locateConversation,
  useAction,
  useNavigation,
  useRpc,
  useSettings,
  useWorkspace,
} from "@pibot/renderer-kit";

type HandoffItem = Extract<InboxItem, { kind: "computer_handoff" }>;

/** "2 minutes ago" in the interface language. */
function ago(at: string, language: string) {
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60_000);
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  if (minutes < 60) return format.format(-Math.max(0, minutes), "minute");
  if (minutes < 48 * 60) return format.format(-Math.round(minutes / 60), "hour");
  return format.format(-Math.round(minutes / 1440), "day");
}

/** "需要你操作" in the inbox: the chat card, compact, plus "go to chat". */
export function HandoffInboxCard({ item, close }: { item: HandoffItem; close(): void }) {
  const { peer } = useRpc();
  const { t, language } = useSettings();
  const data = useWorkspace();
  const task = useAction();
  const { navigate } = useNavigation();
  const { notice } = item;
  const place =
    item.conversationTitle ??
    t(item.conversationKind === "dm" ? "workspace.sourceDm" : "workspace.sourceGroup");
  const openChat = () => {
    if (!peer) return;
    void task
      .run((signal) =>
        locateConversation(
          peer,
          notice.conversationId,
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          data.bots,
          data.groups,
          notice.botId,
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
    <ComputerHandoffInbox
      notice={notice}
      meta={`${ago(notice.createdAt, language)} · ${place}`}
      openChat={openChat}
      openBusy={task.busy}
    />
  );
}
