import { useT } from "@pibot/renderer-kit";
import { Topics } from "../../workspace/topics/Topics.tsx";
import { TopicPopover } from "./TopicPopover.tsx";
import { useTopicTitle } from "./use-topic-title.ts";
export function TopicMenu({
  botId,
  conversationId,
  draft,
}: {
  botId: string;
  conversationId?: string;
  draft: boolean;
}) {
  const t = useT(),
    topic = useTopicTitle(botId, conversationId, draft);
  const title =
    draft || !conversationId
      ? t("workspace.newTopic")
      : topic.title === undefined
        ? t(topic.error ? "workspace.untitled" : "common.loading")
        : topic.title || t("workspace.untitled");
  return (
    <TopicPopover title={title} error={topic.error} retry={topic.retry}>
      <Topics botId={botId} conversationId={conversationId} draft={draft} />
    </TopicPopover>
  );
}
