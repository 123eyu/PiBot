import type { Bot } from "@pibot/protocol";
import { useNavigation, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useLinkState, useRuntime, useText } from "../../runtime/context.tsx";
import { useAction } from "../../runtime/use-action.ts";
import { type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { BotAvatar } from "../../ui/avatar.tsx";
import { CheckMark, Field, ListCard, SectionTitle, Separator } from "../../ui/controls.tsx";
import { TextAction } from "../../ui/headers.tsx";
import { useToast } from "../../ui/toast.tsx";
import { useRemoteValue } from "../chat/controls/use-remote-value.ts";
import { botLook } from "../conversations/model.ts";
import { createGroup, listBots } from "./calls.ts";
import { Note, SettingsPage } from "./fields.tsx";

const MIN = 2,
  MAX = 6;
/** New group: a name and 2 to 6 existing Bots; folders and budgets are chosen on the computer. */
export function CreateGroupScreen() {
  const t = useText(),
    colors = useColors(),
    runtime = useRuntime(),
    mobile = useLinkState(),
    router = useRouter(),
    navigation = useNavigation(),
    toast = useToast();
  const bots = useRemoteValue("new-group:bots", (signal) => listBots(runtime, signal), [
    "bots.changed",
  ]);
  const action = useAction(`${mobile.selectedId}:new-group`, mobile.peer);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const toggle = (bot: Bot) =>
    setChosen((ids) =>
      ids.includes(bot.id)
        ? ids.filter((id) => id !== bot.id)
        : ids.length < MAX
          ? [...ids, bot.id]
          : ids,
    );
  const ready = !!name.trim() && chosen.length >= MIN && bots.online && !action.busy;
  const create = () =>
    action.run(async (signal) => {
      const group = await createGroup(runtime, name.trim(), chosen, signal);
      toast(t("groupCreated"));
      // The form is replaced, so back from the new group skips it; a form already left (back
      // gesture while creating) must not replace the page that is shown instead.
      if (navigation.isFocused()) router.replace(`/conversation/group/${group.id}`);
    });
  const picked = (bots.value ?? []).filter((bot) => chosen.includes(bot.id));
  return (
    <SettingsPage
      title={t("newGroup")}
      state={{
        online: bots.online,
        cached: !bots.online,
        conflict: false,
        error: action.error ?? bots.action.error,
      }}
      footer={t("groupDesktopOnly")}
      left={<TextAction plain title={t("cancel")} onPress={() => router.back()} />}
      right={
        <TextAction title={t("createGroup")} disabled={!ready} onPress={() => void create()} />
      }
    >
      <SectionTitle title={t("newGroupName")} />
      <View style={{ paddingHorizontal: 16 }}>
        <Field
          value={name}
          maxLength={200}
          placeholder={t("newGroupNamePlaceholder")}
          accessibilityLabel={t("newGroupName")}
          onChangeText={setName}
        />
      </View>
      <SectionTitle title={t("newGroupMembers")} />
      {picked.length > 0 && (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            gap: 8,
            minHeight: 44,
            alignItems: "center",
            paddingHorizontal: 16,
            paddingBottom: 6,
          }}
        >
          {picked.map((bot) => (
            <BotAvatar key={bot.id} bot={botLook(bot)} size={36} />
          ))}
        </View>
      )}
      <ListCard>
        {(bots.value ?? []).map((bot, index) => {
          const on = chosen.includes(bot.id);
          return (
            <View key={bot.id}>
              {index > 0 && <Separator />}
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                onPress={() => toggle(bot)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  minHeight: 56,
                  paddingVertical: 10,
                  paddingHorizontal: 16,
                  backgroundColor: pressed ? colors.hover : "transparent",
                })}
              >
                <CheckMark on={on} />
                <BotAvatar bot={botLook(bot)} size={36} />
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
              </Pressable>
            </View>
          );
        })}
        {bots.value && !bots.value.length && <Note text={t("noContacts")} />}
      </ListCard>
    </SettingsPage>
  );
}
