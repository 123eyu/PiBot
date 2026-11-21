import { View } from "react-native";
import { useText } from "../../runtime/context.tsx";
import { ListCard, Separator } from "../../ui/controls.tsx";
import { OptionRow, Radio, Sheet, SheetLabel, SheetTitle } from "../../ui/sheet.tsx";
import { ConversationAvatar } from "../conversations/ConversationRow.tsx";
import { useConversations } from "../conversations/conversations-context.tsx";
import type { RecordScope } from "./model.ts";

/** One Bot or group for the records page (the desktop's Bot picker, plus groups). */
export function ScopeSheet({
  visible,
  value,
  onClose,
  onPick,
}: {
  visible: boolean;
  value: RecordScope;
  onClose: () => void;
  onPick: (value: RecordScope) => void;
}) {
  const t = useText(),
    conversations = useConversations();
  const bots = conversations.rows.filter((row) => row.kind === "bot");
  const groups = conversations.rows.filter((row) => row.kind === "group");
  const section = (rows: typeof bots) => (
    <ListCard flush>
      {rows.map((row, index) => {
        const on = value?.kind === row.kind && value.id === row.id;
        return (
          <View key={row.key}>
            {index > 0 && <Separator />}
            <OptionRow
              title={row.name}
              lead={<ConversationAvatar row={row} size={28} state="idle" />}
              right={<Radio on={on} />}
              selected={on}
              onPress={() => onPick({ kind: row.kind, id: row.id })}
            />
          </View>
        );
      })}
    </ListCard>
  );
  return (
    <Sheet visible={visible} onClose={onClose}>
      <SheetTitle text={t("recordScopeTitle")} />
      <ListCard flush>
        <OptionRow
          title={t("recordScopeAll")}
          right={<Radio on={!value} />}
          selected={!value}
          onPress={() => onPick(undefined)}
        />
      </ListCard>
      {!!bots.length && <SheetLabel text={t("recordScopeBots")} />}
      {!!bots.length && section(bots)}
      {!!groups.length && <SheetLabel text={t("recordScopeGroups")} />}
      {!!groups.length && section(groups)}
    </Sheet>
  );
}
