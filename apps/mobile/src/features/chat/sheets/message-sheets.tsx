import { messageShownText } from "@pibot/client-core";
import type { Message } from "@pibot/protocol";
import * as Clipboard from "expo-clipboard";
import { View } from "react-native";
import { useSharedText, useText } from "../../../runtime/context.tsx";
import { useColors } from "../../../theme/use-theme.ts";
import { Button, ListCard, Separator } from "../../../ui/controls.tsx";
import { Icon } from "../../../ui/icons.tsx";
import { OptionRow, SheetIcon, SheetText, SheetTitle } from "../../../ui/sheet.tsx";
import { useToast } from "../../../ui/toast.tsx";
import type { ChatPage } from "../use-chat-page.ts";
import { CloseButton, OfflineNote } from "./control-sheets.tsx";

/** The user message a retry starts from: itself, or the question an error/reply answered. */
export function retrySource(messages: readonly Message[], message: Message) {
  if (message.role === "user") return message;
  const index = messages.findIndex((m) => m.id === message.id);
  return messages.slice(0, Math.max(0, index)).findLast((m) => m.role === "user");
}
export function MessageSheet({
  page,
  message,
  onRetry,
  onClose,
}: {
  page: ChatPage;
  message: Message;
  onRetry: (source: Message) => void;
  onClose: () => void;
}) {
  const t = useText(),
    shared = useSharedText(),
    colors = useColors(),
    toast = useToast();
  const source = retrySource(page.chat.messages, message);
  const chevron = <Icon name="chevronRight" color={colors.text2} size={16} />;
  const lead = (name: "copy" | "quote" | "refresh") => (
    <Icon name={name} color={colors.text} size={18} />
  );
  // FORWARD-DISPLAY: a forward copies and previews only what the user wrote; a routine's
  // trigger message what its bubble shows.
  const visible = messageShownText(message, shared);
  const copy = async () => {
    await Clipboard.setStringAsync(visible);
    onClose();
    toast(t("copied"));
  };
  return (
    <>
      <SheetText text={visible.replace(/\s+/g, " ").slice(0, 120)} />
      <ListCard flush>
        <OptionRow
          title={t("copy")}
          lead={lead("copy")}
          right={chevron}
          disabled={!visible}
          onPress={() => void copy()}
        />
        <Separator />
        <OptionRow title={t("quote")} subtitle={t("quoteDesktop")} lead={lead("quote")} disabled />
        <Separator />
        <OptionRow
          title={t("retryFrom")}
          subtitle={page.retry.enabled ? t("retryFromHint") : t("retryGroup")}
          lead={lead("refresh")}
          disabled={
            !page.retry.enabled ||
            !page.online ||
            !source ||
            !!page.chat.runId ||
            page.retry.action.busy
          }
          right={chevron}
          onPress={() => source && onRetry(source)}
        />
      </ListCard>
      <OfflineNote page={page} />
      <CloseButton onClose={onClose} />
    </>
  );
}
export function RetrySheet({ page, onClose }: { page: ChatPage; onClose: () => void }) {
  const t = useText(),
    toast = useToast();
  const plan = page.retry.plan;
  const confirm = async () => {
    if ((await page.retry.confirm()) === undefined) return;
    onClose();
    toast(t("retryStarted"));
  };
  const files = !!plan?.restoreFiles && plan.fileCount > 0;
  return (
    <>
      {files && <SheetIcon name="face" />}
      <SheetTitle center={files} text={t("retryTitle")} />
      <SheetText center={files} text={t("retryDiscard")} />
      {files && <SheetText center text={t("retryFiles", { count: plan?.fileCount ?? 0 })} />}
      <OfflineNote page={page} />
      <View style={{ gap: 8 }}>
        <Button
          size="lg"
          variant="prim"
          icon={files ? "face" : undefined}
          title={t("retryConfirm")}
          disabled={!plan || !page.online || page.retry.action.busy}
          onPress={() => void confirm()}
        />
        <Button size="lg" variant="ghost" title={t("cancel")} onPress={onClose} />
      </View>
    </>
  );
}
