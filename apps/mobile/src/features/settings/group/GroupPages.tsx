import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useSharedText, useText } from "../../../runtime/context.tsx";
import { type } from "../../../theme/scale.ts";
import { useColors } from "../../../theme/use-theme.ts";
import { BotAvatar } from "../../../ui/avatar.tsx";
import { Button, Separator } from "../../../ui/controls.tsx";
import { botLook } from "../../conversations/model.ts";
import { RemoveButton } from "../bot/ResourcePages.tsx";
import { Group, Note, SettingsPage } from "../fields.tsx";
import type { GroupSettingsState } from "../use-group-settings.ts";

type Props = { state: GroupSettingsState };
const MIN_MEMBERS = 2,
  MAX_MEMBERS = 6;

export function MembersPage({ state }: Props) {
  const t = useText(),
    colors = useColors();
  const { group, data } = state;
  const members = new Set(group?.members.map((member) => member.botId));
  const bots = data?.bots ?? [];
  const row = (bot: (typeof bots)[number], action: ReactNode) => (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        minHeight: 56,
        paddingVertical: 10,
        paddingHorizontal: 16,
      }}
    >
      <BotAvatar bot={botLook(bot)} size={32} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={[type.rowTitle, { color: colors.text }]} numberOfLines={1}>
          {bot.name}
        </Text>
        {!!bot.description && (
          <Text style={[type.caption, { color: colors.text2 }]} numberOfLines={1}>
            {bot.description}
          </Text>
        )}
      </View>
      {action}
    </View>
  );
  const inGroup = bots.filter((bot) => members.has(bot.id));
  const others = bots.filter((bot) => !members.has(bot.id));
  return (
    <SettingsPage title={t("members")} state={state} footer={t("membersNote")}>
      {group && (
        <>
          <Group title={t("members")}>
            {inGroup.map((bot, index) => (
              <View key={bot.id}>
                {index > 0 && <Separator />}
                {row(
                  bot,
                  <Button
                    variant="danger"
                    title={t("removeMember")}
                    disabled={!state.editable || inGroup.length <= MIN_MEMBERS}
                    onPress={() => void state.setMember(bot.id, false)}
                  />,
                )}
              </View>
            ))}
          </Group>
          {!!others.length && (
            <Group title={t("addMember")}>
              {others.map((bot, index) => (
                <View key={bot.id}>
                  {index > 0 && <Separator />}
                  {row(
                    bot,
                    <Button
                      icon="plus"
                      title={t("addMember")}
                      disabled={!state.editable || inGroup.length >= MAX_MEMBERS}
                      onPress={() => void state.setMember(bot.id, true)}
                    />,
                  )}
                </View>
              ))}
            </Group>
          )}
        </>
      )}
    </SettingsPage>
  );
}
export function GroupMemoryPage({ state }: Props) {
  const t = useText(),
    shared = useSharedText(),
    colors = useColors();
  const memory = state.data?.memory;
  return (
    <SettingsPage title={t("groupMemory")} state={state}>
      {state.data && (
        <Group>
          {!memory ? (
            <Note text={t("sectionUnavailable")} />
          ) : memory.memories.length ? (
            memory.memories.map((note, index) => (
              <View key={note.id}>
                {index > 0 && <Separator />}
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    minHeight: 56,
                    paddingVertical: 6,
                    paddingLeft: 16,
                    paddingRight: 6,
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Text style={{ fontSize: 15, lineHeight: 21, color: colors.text }}>
                      {note.text}
                    </Text>
                    {note.category && (
                      <Text style={{ fontSize: 12, color: colors.text2 }}>
                        {shared(`workspace.category.${note.category}`)}
                      </Text>
                    )}
                  </View>
                  <RemoveButton
                    disabled={!state.editable}
                    onRemove={() => void state.removeMemory(note.id)}
                  />
                </View>
              </View>
            ))
          ) : (
            <Note text={t("noMemories")} />
          )}
        </Group>
      )}
    </SettingsPage>
  );
}
