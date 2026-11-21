import { useNavigation, useRouter } from "expo-router";
import { useShareIntentContext } from "expo-share-intent";
import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { z } from "zod";
import type { MobileKey } from "../../i18n/messages.ts";
import { useLinkState, useRuntime, useText } from "../../runtime/context.tsx";
import { useColors } from "../../theme/use-theme.ts";
import {
  Button,
  EmptyState,
  ErrorLine,
  ListCard,
  SectionTitle,
  Separator,
} from "../../ui/controls.tsx";
import { NavBar } from "../../ui/headers.tsx";
import { Icon } from "../../ui/icons.tsx";
import { useToast } from "../../ui/toast.tsx";
import { listTopics } from "../chat/controls/calls.ts";
import { ConversationAvatar } from "../conversations/ConversationRow.tsx";
import { useConversations } from "../conversations/conversations-context.tsx";
import type { Conversation } from "../conversations/model.ts";
import { discardShared, prepareShared, sharedText } from "./prepare-native.ts";

const CachedTopicSchema = z.object({ current: z.uuid().optional() });

/**
 * Share to Pi Bot: pick a Bot or group (most recent first), add a note, and the shared
 * text, link, images and files go to that conversation's current topic through the outbox, so a
 * computer that is offline gets them when it is back.
 */
export function ShareScreen() {
  const colors = useColors(),
    t = useText(),
    router = useRouter(),
    navigation = useNavigation(),
    toast = useToast(),
    insets = useSafeAreaInsets(),
    runtime = useRuntime(),
    mobile = useLinkState(),
    conversations = useConversations(),
    share = useShareIntentContext();
  const [target, setTarget] = useState<Conversation>();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MobileKey>();
  // Leaving the page by any route (system back included) ends this share; the next one opens anew.
  // (The hook's reset function is recreated every render, so the cleanup reads the latest one.)
  const reset = useRef(share.resetShareIntent);
  reset.current = share.resetShareIntent;
  useEffect(() => () => reset.current(), []);
  const text = sharedText(share.shareIntent);
  const fileCount = share.shareIntent.files?.length ?? 0;
  const close = () => {
    share.resetShareIntent();
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)/chat");
  };
  const topicOf = async (row: Conversation) => {
    if (row.kind === "group" && row.topicId) return row.topicId;
    if (mobile.status === "online") {
      const rows = await listTopics(runtime, row.kind, row.id);
      return rows.find((topic) => topic.isCurrent)?.id ?? rows[0]?.id;
    }
    // Offline: the topic the chat page last saw for this conversation.
    const cached = CachedTopicSchema.safeParse(
      await runtime.storage.data.get(`cache:${mobile.selectedId}:topics:${row.kind}:${row.id}`),
    );
    return cached.success ? cached.data.current : undefined;
  };
  const send = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(undefined);
    let files: Awaited<ReturnType<typeof prepareShared>>["files"] = [];
    try {
      const topicId = await topicOf(target);
      if (!topicId) {
        setError("shareNoTopic");
        return;
      }
      const prepared = await prepareShared(share.shareIntent);
      files = prepared.files;
      const message = [note.trim(), text].filter(Boolean).join("\n\n").slice(0, 8000);
      if (!message && !files.length) {
        setError("shareEmpty");
        return;
      }
      await runtime.send(
        target.kind === "bot" ? { botId: target.id, topicId } : { groupId: target.id, topicId },
        message,
        undefined,
        files,
      );
      files = [];
      if (prepared.skipped) toast(t("shareSkipped", { count: prepared.skipped }));
      else toast(t(mobile.status === "online" ? "shareSent" : "shareQueued"));
      share.resetShareIntent();
      // Left by a back gesture while sending: do not replace the page shown instead.
      if (navigation.isFocused()) router.replace(`/conversation/${target.kind}/${target.id}`);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      setError(
        code === "outbox_files_full"
          ? "attachOutboxFull"
          : code === "attachments_too_large"
            ? "attachTooLarge"
            : "shareFailed",
      );
    } finally {
      // Copies that never reached the outbox are not kept.
      discardShared(files);
      setBusy(false);
    }
  };
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <NavBar title={t("shareTitle")} onBack={close} />
      <ScrollView contentContainerStyle={{ paddingBottom: 16 }} keyboardShouldPersistTaps="handled">
        <View style={{ padding: 16, gap: 6 }}>
          {!!text && (
            <Text numberOfLines={4} style={{ color: colors.text, fontSize: 14 }}>
              {text}
            </Text>
          )}
          {fileCount > 0 && (
            <Text style={{ color: colors.text2, fontSize: 13 }}>
              {t("shareFiles", { count: fileCount })}
            </Text>
          )}
          {!text && !fileCount && (
            <Text style={{ color: colors.text2, fontSize: 13 }}>{t("shareEmpty")}</Text>
          )}
        </View>
        <SectionTitle title={t("shareTo")} />
        {conversations.rows.length === 0 ? (
          <EmptyState icon="message" title={t("shareNoChats")} />
        ) : (
          <ListCard>
            {conversations.rows.slice(0, 50).map((row, index) => (
              <View key={row.key}>
                {index > 0 && <Separator />}
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ selected: target?.key === row.key }}
                  onPress={() => setTarget(row)}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    padding: 10,
                    backgroundColor:
                      target?.key === row.key
                        ? colors.hover
                        : pressed
                          ? colors.hover
                          : "transparent",
                  })}
                >
                  <ConversationAvatar row={row} size={36} />
                  <Text numberOfLines={1} style={{ flex: 1, color: colors.text, fontSize: 15 }}>
                    {row.name}
                  </Text>
                  {target?.key === row.key && <Icon name="check" color={colors.accent} size={20} />}
                </Pressable>
              </View>
            ))}
          </ListCard>
        )}
      </ScrollView>
      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: colors.b1,
          padding: 12,
          paddingBottom: 12 + insets.bottom,
          gap: 8,
        }}
      >
        <ErrorLine text={error && t(error)} />
        <TextInput
          value={note}
          onChangeText={setNote}
          maxLength={2000}
          multiline
          placeholder={t("shareNote")}
          placeholderTextColor={colors.text2}
          accessibilityLabel={t("shareNote")}
          style={{
            minHeight: 38,
            maxHeight: 96,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.b2,
            backgroundColor: colors.card,
            color: colors.text,
            paddingHorizontal: 12,
            paddingVertical: 8,
            fontSize: 15,
          }}
        />
        <Button
          size="lg"
          variant="prim"
          title={busy ? t("sharePreparing") : t("shareSend")}
          disabled={!target || busy || (!text && !fileCount && !note.trim())}
          onPress={() => void send()}
        />
      </View>
    </KeyboardAvoidingView>
  );
}
