import { Pressable, Text, View } from "react-native";
import { useText } from "../../runtime/context.tsx";
import { radius, space, type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import { type AvatarState, BotAvatar, GroupAvatar, MainBadge } from "../../ui/avatar.tsx";
import { UnreadDot } from "../../ui/controls.tsx";
import { latinQuotes } from "../../ui/markdown.tsx";
import { useTimeText } from "../../ui/time.ts";
import { type Conversation, plainPreview } from "./model.ts";

export function ConversationAvatar({
  row,
  size = 44,
  state,
}: {
  row: Conversation;
  size?: number;
  state?: AvatarState;
}) {
  const t = useText();
  const look = row.looks[0];
  if (row.kind === "group") return <GroupAvatar members={row.looks} size={size} />;
  return look ? (
    <View>
      <BotAvatar bot={look} size={size} state={state} />
      {row.main && <MainBadge label={t("mainBot")} />}
    </View>
  ) : (
    <View style={{ width: size, height: size }} />
  );
}
/** The row's avatar motion: running sways, an approval waits; as in the desktop sidebar. */
export function rowState(running: boolean, waiting: boolean): AvatarState {
  return running ? "working" : waiting ? "waiting" : "idle";
}
/**
 * The desktop sidebar row: a rounded full-width button without dividers. Status is written into
 * the preview line (amber while waiting, red on errors) and shown by the avatar's motion.
 */
export function ConversationRow({
  row,
  unread,
  running,
  waiting,
  unavailable,
  onPress,
}: {
  row: Conversation;
  unread: boolean;
  running: boolean;
  waiting?: string;
  /** An agent Bot while the computer is offline; its history still opens from the cache. */
  unavailable?: boolean;
  onPress: () => void;
}) {
  const colors = useColors(),
    t = useText(),
    time = useTimeText();
  const failed = row.preview && (row.preview.role === "error" || row.preview.status === "error");
  // B13: the bubbles' apostrophe fix (F8) reaches the list too; B16: no raw Markdown.
  const previewText = row.preview ? latinQuotes(plainPreview(row.preview.text)) : undefined;
  const at = row.preview?.at ?? row.updatedAt;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        padding: space.rowPad,
        marginHorizontal: space.rowInset,
        borderRadius: radius.row,
        backgroundColor: pressed ? colors.hover : "transparent",
      })}
    >
      <View style={unavailable ? { opacity: 0.45 } : undefined}>
        <ConversationAvatar row={row} state={rowState(running, !!waiting)} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <View
            style={{
              flexShrink: 1,
              minWidth: 0,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Text
              numberOfLines={1}
              style={[
                type.listName,
                { flexShrink: 1, color: unavailable ? colors.text2 : colors.text },
              ]}
            >
              {row.name}
            </Text>
            {unread && <UnreadDot label={t("unread")} />}
          </View>
          <Text style={[type.time, { color: colors.text2, fontVariant: ["tabular-nums"] }]}>
            {time.list(at)}
          </Text>
        </View>
        <Text
          numberOfLines={1}
          style={[
            type.preview,
            {
              color: unavailable
                ? colors.text2
                : waiting && !running
                  ? colors.warn
                  : failed && !running
                    ? colors.danger
                    : colors.text2,
            },
          ]}
        >
          {unavailable
            ? t("agentNeedsComputer")
            : running
              ? t("previewRunning")
              : waiting
                ? `${t("previewWaiting")} ${waiting}`
                : failed
                  ? previewText || t("previewFailed")
                  : previewText}
        </Text>
      </View>
    </Pressable>
  );
}
/** A pinned conversation: the sidebar's square tile, two to a row. */
export function PinnedTile({
  row,
  unread,
  running,
  waiting,
  unavailable,
  onPress,
}: {
  row: Conversation;
  unread: boolean;
  running: boolean;
  waiting: boolean;
  unavailable?: boolean;
  onPress: () => void;
}) {
  const colors = useColors(),
    t = useText();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={row.name}
      onPress={onPress}
      style={{
        flex: 1,
        minHeight: 108,
        padding: 10,
        gap: 8,
        borderRadius: radius.row,
        backgroundColor: colors.tert,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {({ pressed }) => (
        <>
          {pressed && (
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: colors.hover,
              }}
            />
          )}
          <View style={unavailable ? { opacity: 0.45 } : undefined}>
            <ConversationAvatar row={row} size={64} state={rowState(running, waiting)} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%" }}>
            <Text
              numberOfLines={1}
              style={{ flexShrink: 1, fontSize: 15, fontWeight: "600", color: colors.text }}
            >
              {row.name}
            </Text>
            {unread && <UnreadDot label={t("unread")} />}
          </View>
        </>
      )}
    </Pressable>
  );
}
