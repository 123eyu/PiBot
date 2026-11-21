import { useRouter } from "expo-router";
import { Platform, Text, View } from "react-native";
import type { MobileKey } from "../../../i18n/messages.ts";
import { useText } from "../../../runtime/context.tsx";
import { useColors } from "../../../theme/use-theme.ts";
import { Button, ListCard, Separator, StateTag } from "../../../ui/controls.tsx";
import { Icon, type IconName } from "../../../ui/icons.tsx";
import { OptionRow, Radio, SheetLabel, SheetText, SheetTitle } from "../../../ui/sheet.tsx";
import { useTimeText } from "../../../ui/time.ts";
import { useToast } from "../../../ui/toast.tsx";
import type { PickSource } from "../../compose/pick-native.ts";
import type { ChatPage } from "../use-chat-page.ts";
import { CloseButton, OfflineNote } from "./control-sheets.tsx";

export type MenuSheet = "topics" | "mode" | "plus" | "more" | "runinfo";
export function useTopicActions(page: ChatPage, onClose: () => void) {
  const t = useText(),
    toast = useToast();
  return {
    create: async () => {
      if ((await page.topics.create()) === undefined) return;
      onClose();
      toast(t("newTopicDone"));
    },
    switchTo: async (topicId: string) => {
      if (topicId === page.topics.current) return onClose();
      if ((await page.topics.switchTo(topicId)) === undefined) return;
      onClose();
      toast(t("topicSwitched"));
    },
  };
}
export function TopicsSheet({ page, onClose }: { page: ChatPage; onClose: () => void }) {
  const t = useText(),
    time = useTimeText(),
    actions = useTopicActions(page, onClose);
  const busy = !page.online || page.topics.write.busy;
  return (
    <>
      <SheetTitle text={t("topicsTitle")} />
      <OfflineNote page={page} />
      <ListCard flush>
        {page.topics.topics.map((topic, index) => (
          <View key={topic.id}>
            {index > 0 && <Separator />}
            <OptionRow
              title={`# ${topic.title || t("untitledTopic")}`}
              disabled={busy}
              selected={topic.id === page.topics.current}
              value={topic.id === page.topics.current ? undefined : time.list(topic.updatedAt)}
              right={
                topic.id === page.topics.current && (
                  <StateTag kind="done" label={t("topicCurrent")} />
                )
              }
              onPress={() => void actions.switchTo(topic.id)}
            />
          </View>
        ))}
      </ListCard>
      <Button
        size="lg"
        variant="prim"
        icon="plus"
        title={t("newTopic")}
        disabled={busy}
        onPress={() => void actions.create()}
      />
      <CloseButton onClose={onClose} />
    </>
  );
}
export function ModeSheet({ page, onClose }: { page: ChatPage; onClose: () => void }) {
  const t = useText();
  const mode = page.mode;
  const disabled = !page.online || !mode.value || mode.write.busy;
  return (
    <>
      <SheetTitle text={t("modeTitle")} />
      {mode.enabled ? (
        <>
          <OfflineNote page={page} />
          <ListCard flush>
            <OptionRow
              title={t("modeExecute")}
              subtitle={t("modeExecuteHint")}
              disabled={disabled}
              selected={mode.mode === "execute"}
              right={<Radio on={mode.mode === "execute"} />}
              onPress={() => void mode.change("execute")}
            />
            <Separator />
            <OptionRow
              title={t("modePlan")}
              subtitle={t("modePlanHint")}
              disabled={disabled}
              selected={mode.mode === "plan"}
              right={<Radio on={mode.mode === "plan"} />}
              onPress={() => void mode.change("plan")}
            />
          </ListCard>
          <SheetLabel text={t("busyLabel")} />
          <ListCard flush>
            <OptionRow
              title={t("busySteer")}
              subtitle={t("busySteerHint")}
              selected={mode.busyMode === "steer"}
              right={<Radio on={mode.busyMode === "steer"} />}
              onPress={() => mode.setBusyMode("steer")}
            />
            <Separator />
            <OptionRow
              title={t("busyQueue")}
              subtitle={t("busyQueueHint")}
              selected={mode.busyMode === "followUp"}
              right={<Radio on={mode.busyMode === "followUp"} />}
              onPress={() => mode.setBusyMode("followUp")}
            />
          </ListCard>
        </>
      ) : (
        <SheetText text={t("modeGroup")} />
      )}
      <CloseButton onClose={onClose} />
    </>
  );
}
export function PlusSheet({
  page,
  open,
  onClose,
}: {
  page: ChatPage;
  open: (sheet: MenuSheet) => void;
  onClose: () => void;
}) {
  const t = useText(),
    colors = useColors(),
    actions = useTopicActions(page, onClose);
  const mode = t(page.mode.mode === "plan" ? "modePlan" : "modeExecute");
  const busy = t(page.mode.busyMode === "steer" ? "busySteer" : "busyQueue");
  return (
    <>
      <SheetTitle text={t("plusTitle")} />
      <ListCard flush>
        <OptionRow
          title={t("newTopic")}
          subtitle={t("newTopicHint")}
          disabled={!page.online || page.topics.write.busy}
          right={<Icon name="chevronRight" color={colors.text2} size={16} />}
          onPress={() => void actions.create()}
        />
        <Separator />
        <OptionRow
          title={t("sendMode")}
          subtitle={page.mode.enabled ? t("sendModeSummary", { mode, busy }) : t("modeGroup")}
          right={<Icon name="chevronRight" color={colors.text2} size={16} />}
          onPress={() => open("mode")}
        />
      </ListCard>
      <AttachRows page={page} onClose={onClose} />
      <CloseButton onClose={onClose} />
    </>
  );
}
// iOS cannot present the picker while the sheet's Modal is still fading out (it silently does
// nothing); the fade is 300 ms.
const AFTER_SHEET_MS = Platform.OS === "ios" ? 450 : 0;
/** Photos, camera and files for the composer; text-only while a reply is steered. */
function AttachRows({ page, onClose }: { page: ChatPage; onClose: () => void }) {
  const t = useText(),
    colors = useColors();
  const composer = page.composer;
  const blocked = composer.steering
    ? t("attachSteering")
    : composer.attachments.full
      ? t("attachFullHint")
      : undefined;
  const pick = (source: PickSource) => {
    onClose();
    setTimeout(() => void composer.attachments.add(source), AFTER_SHEET_MS);
  };
  const rows: [PickSource, IconName, MobileKey, MobileKey][] = [
    ["library", "image", "attachPhotos", "attachPhotosHint"],
    ["camera", "camera", "attachCamera", "attachCameraHint"],
    ["files", "file", "attachFiles", "attachFilesHint"],
  ];
  return (
    <ListCard flush>
      {rows.map(([source, icon, title, hint], index) => (
        <View key={source}>
          {index > 0 && <Separator />}
          <OptionRow
            title={t(title)}
            subtitle={blocked ?? t(hint)}
            lead={<Icon name={icon} color={colors.text} size={18} />}
            disabled={!composer.canAttach}
            onPress={() => pick(source)}
          />
        </View>
      ))}
    </ListCard>
  );
}
export function MoreSheet({
  page,
  open,
  onClose,
  onBrowser,
}: {
  page: ChatPage;
  open: (sheet: MenuSheet) => void;
  onClose: () => void;
  onBrowser: () => void;
}) {
  const t = useText(),
    colors = useColors(),
    toast = useToast(),
    router = useRouter(),
    actions = useTopicActions(page, onClose);
  const compacting = page.compact.running || !!page.chat.status.compacting;
  const startCompact = () => {
    onClose();
    toast(t("compacting"));
    void page.compact.start().then((done) => done && toast(t("compacted")));
  };
  const cancelCompact = async () => {
    if ((await page.compact.cancel()) === undefined) return;
    onClose();
    toast(t("compactCancelled"));
  };
  const chevron = <Icon name="chevronRight" color={colors.text2} size={16} />;
  const lead = (name: IconName) => <Icon name={name} color={colors.text} size={18} />;
  return (
    <>
      <SheetTitle text={page.entry?.name ?? ""} />
      {/* The Bot's or group's settings, the same pages as from Contacts. */}
      <ListCard flush>
        <OptionRow
          title={t(page.kind === "bot" ? "botSettings" : "groupSettings")}
          lead={lead(page.kind === "bot" ? "settings" : "users")}
          right={chevron}
          onPress={() => {
            onClose();
            router.push(`/settings/${page.kind}/${page.id}`);
          }}
        />
      </ListCard>
      <ListCard flush>
        <OptionRow
          title={t("newTopic")}
          lead={lead("plus")}
          disabled={!page.online || page.topics.write.busy}
          onPress={() => void actions.create()}
        />
        <Separator />
        <OptionRow
          title={t("switchTopic")}
          lead={lead("message")}
          right={chevron}
          onPress={() => open("topics")}
        />
        {page.compact.enabled && (
          <>
            <Separator />
            {compacting ? (
              <OptionRow
                title={t("compactCancel")}
                lead={lead("close")}
                disabled={!page.online || !page.compact.running}
                right={chevron}
                onPress={() => void cancelCompact()}
              />
            ) : (
              <OptionRow
                title={t("compact")}
                subtitle={t("compactHint")}
                lead={lead("refresh")}
                disabled={!page.online || !!page.chat.runId}
                right={chevron}
                onPress={startCompact}
              />
            )}
            <Separator />
            <OptionRow
              title={t("runInfo")}
              subtitle={t("runInfoHint")}
              lead={lead("info")}
              right={chevron}
              onPress={() => open("runinfo")}
            />
          </>
        )}
        {page.browser.enabled && (
          <>
            <Separator />
            <OptionRow
              title={t("browserMenu")}
              subtitle={t("browserMenuHint")}
              lead={lead("globe")}
              right={chevron}
              onPress={onBrowser}
            />
          </>
        )}
      </ListCard>
      <Text style={{ fontSize: 13.5, color: colors.text2 }}>
        {t(page.compact.enabled ? "moreDesktop" : "groupDesktop")}
      </Text>
      <CloseButton onClose={onClose} />
    </>
  );
}
export function RunInfoSheet({ page, onClose }: { page: ChatPage; onClose: () => void }) {
  const t = useText(),
    time = useTimeText();
  const budget = page.runInfo.budget;
  const row = (title: string, value: string) => <OptionRow title={title} value={value} />;
  return (
    <>
      <SheetTitle text={t("runInfo")} />
      {budget ? (
        <ListCard flush>
          {row(t("runRequests"), t("runRequestsValue", { count: budget.requests }))}
          <Separator />
          {row(t("runTime"), time.duration(budget.activeMillis))}
          <Separator />
          {row(
            t("runCost"),
            budget.unknownCostRequests
              ? t("runUnknown")
              : t("runCostValue", { cost: budget.knownCostUsd.toFixed(2) }),
          )}
          {!!page.entry?.modelId && (
            <>
              <Separator />
              {row(t("runModel"), page.entry.modelId)}
            </>
          )}
        </ListCard>
      ) : (
        <SheetText text={t("runInfoEmpty")} />
      )}
      <CloseButton onClose={onClose} />
    </>
  );
}
