import { Text, View } from "react-native";
import { useText } from "../../runtime/context.tsx";
import { type } from "../../theme/scale.ts";
import { useColors } from "../../theme/use-theme.ts";
import type { PendingMessage } from "../../transport/link-port.ts";
import { Button } from "../../ui/controls.tsx";
import { Icon } from "../../ui/icons.tsx";
import { UserBubble } from "../chat/messages/MessageItem.tsx";
import { LocalFileChip } from "./AttachmentTray.tsx";

/**
 * A message still in the phone outbox, or just accepted and waiting for the reloaded history
 *Its text, its local files, and where it stands — queued offline, uploading with a
 * percentage, or stopped with retry and remove.
 */
export function PendingSend({
  pending,
  color,
  online,
  reconnecting,
  progress,
  failed,
  onRetry,
  onDiscard,
}: {
  pending: PendingMessage & { userMessageId?: string };
  color: string;
  online: boolean;
  /** The link is coming back (path switch, short drop): the send waits and goes in order. */
  reconnecting?: boolean;
  /** 0–1 while its files upload. */
  progress?: number;
  failed: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const colors = useColors(),
    t = useText();
  const files = pending.files ?? [];
  const accepted = !!pending.userMessageId;
  const line = (icon: "clock" | "check", text: string) => (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Icon name={icon} color={colors.text2} size={12} />
      <Text style={[type.small, { color: colors.text2 }]}>{text}</Text>
    </View>
  );
  // Proposal 5: every send says where it stands, 待发送 until the computer's receipt, then 已送达
  // until the thread's history carries the stored message.
  const status = (() => {
    if (accepted) return line("check", t("pendingDelivered"));
    if (failed)
      return (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name="warning" color={colors.danger} size={13} />
          <Text style={[type.small, { color: colors.danger }]}>{t("pendingFailed")}</Text>
          <Button icon="refresh" title={t("pendingRetry")} onPress={onRetry} />
          <Button title={t("pendingDiscard")} variant="ghost" onPress={onDiscard} />
        </View>
      );
    if (reconnecting) return line("clock", t("pendingReconnecting"));
    if (!online) return line("clock", t("queuedNote"));
    if (progress !== undefined && progress < 1)
      return (
        <Text style={[type.small, { color: colors.text2, fontVariant: ["tabular-nums"] }]}>
          {t("pendingUploading", { percent: Math.floor(progress * 100) })}
        </Text>
      );
    return line("clock", t("pendingWaiting"));
  })();
  return (
    <View style={{ alignSelf: "flex-end", maxWidth: "80%", alignItems: "flex-end", gap: 6 }}>
      {!!pending.text && <UserBubble text={pending.text} color={color} />}
      {files.length > 0 && (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            justifyContent: "flex-end",
            gap: 6,
            opacity: accepted ? 1 : 0.75,
          }}
        >
          {files.map((file) => (
            <LocalFileChip key={file.blob} file={file} compact />
          ))}
        </View>
      )}
      {status}
    </View>
  );
}
