import { useRouter } from "expo-router";
import { Text, View } from "react-native";
import { useSharedText, useText } from "../../../runtime/context.tsx";
import { monoFont, onFill, useColors } from "../../../theme/use-theme.ts";
import { Button, ListCard, Separator } from "../../../ui/controls.tsx";
import { OfflineBanner } from "../../../ui/headers.tsx";
import { Icon } from "../../../ui/icons.tsx";
import { OptionRow, Radio, SheetIcon, SheetText, SheetTitle } from "../../../ui/sheet.tsx";
import { useToast } from "../../../ui/toast.tsx";
import { diffHref } from "../../changes/calls.ts";
import { FileTag, LineCounts } from "../../changes/FileTag.tsx";
import { changesTarget } from "../controls/scope.ts";
import type { ChatPage } from "../use-chat-page.ts";
import { RunnerFolderSheet } from "./RunnerFolderSheet.tsx";

export function OfflineNote({ page }: { page: ChatPage }) {
  const t = useText();
  return page.online ? null : <OfflineBanner text={t("actionsOffline")} />;
}
export function CloseButton({ onClose }: { onClose: () => void }) {
  const t = useText();
  return <Button size="lg" title={t("close")} onPress={onClose} />;
}
export function FolderSheet({ page, onClose }: { page: ChatPage; onClose: () => void }) {
  const t = useText(),
    shared = useSharedText(),
    toast = useToast();
  const value = page.workplace.value;
  const choose = async (folderId: string) => {
    if ((await page.workplace.choose(folderId)) === undefined) return;
    onClose();
    toast(t("folderChanged"));
  };
  return (
    <>
      <SheetTitle text={t("folderTitle")} />
      {!page.workplace.enabled ? (
        <SheetText text={t("folderGroup")} />
      ) : (
        <>
          <SheetText text={t("folderHint")} />
          {/* Why runs here fail, and that picking a folder on this computer fixes it (B7). */}
          {value?.runnerOffline && <SheetText text={shared("errors.runner_offline")} />}
          <OfflineNote page={page} />
          {value && (
            <ListCard flush>
              <OptionRow
                title={t("folderHome")}
                subtitle={`${value.home} · ${t("folderDefault")}`}
                selected={value.folderId === "home"}
                disabled={!page.online || page.workplace.write.busy}
                right={<Radio on={value.folderId === "home"} />}
                onPress={() => void choose("home")}
              />
              {value.folders.map((folder) => (
                <View key={folder.id}>
                  <Separator />
                  <OptionRow
                    title={folder.name}
                    subtitle={`${folder.path} · ${t(value.readonly.includes(folder.id) ? "folderReadonly" : "folderWritable")}`}
                    selected={value.folderId === folder.id}
                    disabled={!page.online || page.workplace.write.busy}
                    right={<Radio on={value.folderId === folder.id} />}
                    onPress={() => void choose(folder.id)}
                  />
                </View>
              ))}
            </ListCard>
          )}
          <RunnerFolderSheet page={page} done={onClose} />
        </>
      )}
      <CloseButton onClose={onClose} />
    </>
  );
}
/** Desktop plan card mark: green tick when done, a blue open ring for the step in progress. */
function PlanMark({ status }: { status: string }) {
  const colors = useColors();
  const done = status === "done";
  const running = status === "in_progress";
  return (
    <View
      style={{
        width: 18,
        height: 18,
        borderRadius: 9,
        borderWidth: 2,
        borderColor: done ? colors.ok : running ? colors.accent : colors.b3,
        borderRightColor: running ? "transparent" : undefined,
        backgroundColor: done ? colors.ok : "transparent",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {done && <Icon name="check" color={onFill(colors)} size={11} strokeWidth={3} />}
    </View>
  );
}
export function PlanSheet({ page, onClose }: { page: ChatPage; onClose: () => void }) {
  const t = useText(),
    colors = useColors();
  return (
    <>
      <SheetTitle text={t("planTitle")} />
      <SheetText text={t("planHint", { name: page.entry?.name ?? "" })} />
      <ListCard flush style={{ paddingVertical: 4 }}>
        {page.plan.items.map((item) => {
          const done = item.status === "done";
          return (
            <View
              key={item.id}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                minHeight: 40,
                paddingVertical: 6,
                paddingHorizontal: 16,
              }}
            >
              <PlanMark status={item.status} />
              <Text
                style={{
                  flex: 1,
                  fontSize: 14.5,
                  lineHeight: 21,
                  color: done ? colors.text2 : colors.text,
                  textDecorationLine: done ? "line-through" : "none",
                  textDecorationColor: colors.b3,
                }}
              >
                {item.title}
              </Text>
            </View>
          );
        })}
      </ListCard>
      <CloseButton onClose={onClose} />
    </>
  );
}
export function ChangesSheet({
  page,
  onRestore,
  onClose,
}: {
  page: ChatPage;
  onRestore: (path: string, name: string) => void;
  onClose: () => void;
}) {
  const t = useText(),
    colors = useColors(),
    router = useRouter();
  const files = page.changes.files;
  const runId = page.changes.value?.runId;
  // Each row opens that file's line diff; restoring stays a separate button.
  const openDiff = (file: (typeof files)[number]) => {
    if (!runId || !page.scope) return;
    onClose();
    router.push(diffHref(runId, changesTarget(page.scope), file));
  };
  return (
    <>
      <SheetTitle text={t("changesTitle")} />
      {files.length ? (
        <>
          <SheetText text={t("changesHint")} />
          <OfflineNote page={page} />
          <ListCard flush>
            {files.map((file, index) => (
              <View key={file.path}>
                {index > 0 && <Separator />}
                <OptionRow
                  title={file.displayPath}
                  mono={monoFont}
                  lead={<FileTag kind={file.kind} />}
                  onPress={runId ? () => openDiff(file) : undefined}
                  subtitle={page.changes.restorable ? undefined : t("restoreUnavailable")}
                  right={
                    <>
                      <LineCounts added={file.added} removed={file.removed} />
                      <Button
                        variant="danger"
                        title={t("restore")}
                        disabled={
                          !page.online || !page.changes.restorable || page.changes.write.busy
                        }
                        onPress={() => onRestore(file.path, file.displayPath)}
                      />
                    </>
                  }
                />
              </View>
            ))}
          </ListCard>
          <Text style={{ fontSize: 13.5, color: colors.text2 }}>{t("changesDesktop")}</Text>
        </>
      ) : (
        <SheetText text={t("changesEmpty")} />
      )}
      <CloseButton onClose={onClose} />
    </>
  );
}
export function RestoreSheet({
  page,
  path,
  name,
  onClose,
}: {
  page: ChatPage;
  path: string;
  name: string;
  onClose: () => void;
}) {
  const t = useText(),
    toast = useToast();
  const confirm = async () => {
    const outcome = await page.changes.restore(path);
    if (outcome === undefined) return;
    onClose();
    toast(t(outcome === "done" ? "restored" : "restorePartial"));
  };
  return (
    <>
      <SheetIcon name="face" />
      <SheetTitle center text={t("restoreTitle", { name })} />
      <SheetText center text={t("restoreHint")} />
      <OfflineNote page={page} />
      <Button
        size="lg"
        variant="danger"
        title={t("restoreConfirm")}
        disabled={!page.online || page.changes.write.busy}
        onPress={() => void confirm()}
      />
      <Button size="lg" variant="ghost" title={t("cancel")} onPress={onClose} />
    </>
  );
}
export function YoloSheet({ page, onClose }: { page: ChatPage; onClose: () => void }) {
  const t = useText(),
    toast = useToast();
  const change = async (on: boolean) => {
    const result = await (on ? page.yolo.turnOn() : page.yolo.turnOff());
    if (result === undefined) return;
    onClose();
    toast(t(result ? "yoloEnabled" : "yoloDisabled"));
  };
  const disabled = !page.online || page.yolo.write.busy || !page.yolo.value;
  if (page.yolo.enabled)
    return (
      <>
        <SheetTitle text={t("yoloOnTitle")} />
        <SheetText text={t("yoloOnHint")} />
        <OfflineNote page={page} />
        <Button
          size="lg"
          variant="prim"
          title={t("yoloTurnOff")}
          disabled={disabled}
          onPress={() => void change(false)}
        />
        <CloseButton onClose={onClose} />
      </>
    );
  return (
    <>
      <SheetIcon name="warning" tone="warn" />
      <SheetTitle center text={t("yoloAskTitle")} />
      <SheetText text={t("yoloAskHint")} />
      <OfflineNote page={page} />
      <Button
        size="lg"
        variant="prim"
        icon="face"
        title={t("yoloTurnOn")}
        disabled={disabled}
        onPress={() => void change(true)}
      />
      <Button size="lg" variant="ghost" title={t("cancel")} onPress={onClose} />
    </>
  );
}
