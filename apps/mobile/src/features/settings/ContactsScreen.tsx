import { useRouter } from "expo-router";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLinkState, useText } from "../../runtime/context.tsx";
import { type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { Banner, EmptyState, ListCard, SectionTitle, Separator } from "../../ui/controls.tsx";
import { HeaderPill, NavBar } from "../../ui/headers.tsx";
import { Icon } from "../../ui/icons.tsx";
import { ConversationAvatar } from "../conversations/ConversationRow.tsx";
import { useConversations } from "../conversations/conversations-context.tsx";
import type { Conversation } from "../conversations/model.ts";

function ContactRow({ row, onPress }: { row: Conversation; onPress: () => void }) {
  const colors = useColors(),
    t = useText();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
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
      <ConversationAvatar row={row} size={40} />
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text style={[type.rowTitle, { color: colors.text }]} numberOfLines={1}>
          {row.name}
        </Text>
        {row.kind === "group" && (
          <Text style={[type.caption, { color: colors.text2 }]}>
            {t("membersCount", { count: row.looks.length })}
          </Text>
        )}
      </View>
      <Icon name="chevronRight" color={colors.text2} size={16} />
    </Pressable>
  );
}
/** Bots and groups by name; tapping one opens its settings. */
export function ContactsScreen() {
  const t = useText(),
    router = useRouter(),
    mobile = useLinkState(),
    list = useConversations(),
    insets = useSafeAreaInsets(),
    colors = useColors();
  const byName = (a: Conversation, b: Conversation) => a.name.localeCompare(b.name);
  const bots = list.rows.filter((row) => row.kind === "bot").sort(byName);
  const groups = list.rows.filter((row) => row.kind === "group").sort(byName);
  const online = mobile.status === "online";
  const section = (title: string, rows: Conversation[]) =>
    !!rows.length && (
      <>
        <SectionTitle title={title} />
        <ListCard>
          {rows.map((row, index) => (
            <View key={row.key}>
              {index > 0 && <Separator />}
              <ContactRow
                row={row}
                onPress={() => router.push(`/settings/${row.kind}/${row.id}`)}
              />
            </View>
          ))}
        </ListCard>
      </>
    );
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <NavBar
        title={t("contacts")}
        onBack={() => router.back()}
        right={
          <HeaderPill
            icon="plus"
            title={t("newGroup")}
            disabled={!online}
            onPress={() => router.push("/settings/new-group")}
          />
        }
      />
      <ScrollView contentContainerStyle={{ paddingBottom: 24 + insets.bottom }}>
        {!online && (
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <Banner text={t("listOffline")} />
          </View>
        )}
        {section(t("contactsBots"), bots)}
        {section(t("contactsGroups"), groups)}
        {!list.rows.length && <EmptyState icon="message" title={t("noContacts")} />}
      </ScrollView>
    </View>
  );
}
