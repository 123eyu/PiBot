import type { ChatPeer } from "@pibot/client-core";
import type { Group, GroupTopic } from "@pibot/protocol";
import { useT } from "@pibot/renderer-kit";
import { TopicPopover } from "../../chat/topics/TopicPopover.tsx";
import { GroupTopicList } from "./GroupTopicList.tsx";
export function GroupTopics({
  peer,
  group,
  select,
  refresh,
  inline = false,
  draft = false,
}: {
  peer: ChatPeer;
  group: Group;
  selected?: GroupTopic;
  select(topic?: GroupTopic): void;
  refresh(): Promise<void>;
  running: boolean;
  inline?: boolean;
  draft?: boolean;
}) {
  const t = useT();
  const list = (
    <GroupTopicList
      peer={peer}
      group={group}
      draft={draft}
      changed={() => {
        select(undefined);
        void refresh();
      }}
    />
  );
  return inline ? (
    list
  ) : (
    <TopicPopover
      title={draft ? t("workspace.newTopic") : group.topicTitle || t("workspace.untitled")}
    >
      {list}
    </TopicPopover>
  );
}
