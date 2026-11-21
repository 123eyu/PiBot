import type { SidebarEntry, SidebarGroup } from "@pibot/protocol";
import { useAction, useNavigation, useRpc, useT, useWorkspace } from "@pibot/renderer-kit";
import { Button, IconTile, TextField } from "@pibot/ui";
import { useState } from "react";
import { Overlay } from "../workspace/Overlay.tsx";
import { DeleteConversationDialog } from "../workspace/topics/DeleteConversationDialog.tsx";
import styles from "../workspace/workspace.module.css";
import side from "./sidebar.module.css";

export type EntryDialogTarget =
  | { kind: "move" | "delete"; entry: SidebarEntry }
  | { kind: "section"; section: SidebarGroup }
  // Maintainers 2026-11-13: the ＋ menu's 新分组 makes an empty section to move chats into later.
  | { kind: "create" };
export function EntryDialog({ target, close }: { target: EntryDialogTarget; close(): void }) {
  const t = useT();
  const { peer } = useRpc();
  const data = useWorkspace();
  const { navigate } = useNavigation();
  const task = useAction();
  const [name, setName] = useState(target.kind === "section" ? target.section.name : "");
  const [remove, setRemove] = useState(false);
  const run = async (operation: () => Promise<unknown>) => {
    const result = await task.run(operation);
    if (result !== undefined) {
      close();
      void data.refresh();
    }
  };
  const group = "entry" in target && target.entry.conversationKey.startsWith("group:");
  if (target.kind === "delete") {
    const id = target.entry.conversationKey.split(":")[1] as string;
    return (
      <DeleteConversationDialog
        target={group ? { groupId: id } : { botId: id }}
        close={close}
        deleted={() => {
          close();
          navigate({ name: "chat" });
          void data.refresh();
        }}
      />
    );
  }
  if (target.kind === "create")
    return (
      <Overlay
        icon="folder"
        tone="amber"
        title={t("workspace.newSectionItem")}
        close={close}
        busy={task.busy}
      >
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            if (peer) void run(() => peer.call("sidebar.groups.create", { name: name.trim() }));
          }}
        >
          <TextField
            label={t("workspace.sectionName")}
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            required
            maxLength={200}
            data-dialog-initial-focus
          />
          <Button type="submit" loading={task.busy} disabled={!peer || !name.trim()}>
            <IconTile icon="folder" tone="amber" size="sm" />
            {t("workspace.createSection")}
          </Button>
        </form>
        {task.error && (
          <p role="alert" className={styles.error}>
            {t(task.error)}
          </p>
        )}
      </Overlay>
    );
  return (
    <Overlay
      icon={target.kind === "move" ? "folder" : target.kind === "section" ? "edit" : "trash"}
      tone={target.kind === "move" ? "teal" : target.kind === "section" ? "blue" : "red"}
      title={t(
        target.kind === "move"
          ? "workspace.move"
          : target.kind === "section"
            ? "workspace.sectionActions"
            : "common.delete",
      )}
      close={close}
      busy={task.busy}
    >
      {target.kind === "section" ? (
        <>
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              if (peer)
                void run(() =>
                  peer.call("sidebar.groups.update", { id: target.section.id, name: name.trim() }),
                );
            }}
          >
            <TextField
              label={t("workspace.sectionName")}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              required
              maxLength={200}
            />
            <Button type="submit" loading={task.busy} disabled={!peer || !name.trim()}>
              <IconTile icon="edit" tone="blue" size="sm" />
              {t("common.save")}
            </Button>
          </form>
          <Button
            variant="ghost"
            className={styles.danger}
            disabled={task.busy}
            onClick={() => setRemove(true)}
          >
            <IconTile icon="trash" tone="red" size="sm" />
            {t("workspace.removeSection")}
          </Button>
          {remove && (
            <div className={styles.confirm}>
              <p>{t("workspace.confirmSection")}</p>
              <Button
                loading={task.busy}
                onClick={() => {
                  if (peer)
                    void run(() => peer.call("sidebar.groups.remove", { id: target.section.id }));
                }}
              >
                {t("common.delete")}
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className={`${styles.list} ${side.moveList}`}>
            {[{ id: null, name: t("workspace.defaultSection") }, ...data.sections].map(
              (section) => (
                <Button
                  key={section.id ?? "default"}
                  variant="secondary"
                  data-current={(target.entry.groupId ?? null) === section.id || undefined}
                  disabled={task.busy}
                  onClick={() => {
                    if (peer)
                      void run(() =>
                        peer.call("sidebar.update", {
                          conversationKey: target.entry.conversationKey,
                          groupId: section.id,
                        }),
                      );
                  }}
                >
                  <IconTile icon="folder" tone={section.id ? "teal" : "neutral"} size="sm" />
                  {section.name}
                </Button>
              ),
            )}
            {data.hasMoreSections && (
              <Button variant="ghost" onClick={() => void data.moreSections()}>
                {t("workspace.more")}
              </Button>
            )}
          </div>
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              if (peer)
                void run(async () => {
                  const section = await peer.call("sidebar.groups.create", { name: name.trim() });
                  return peer.call("sidebar.update", {
                    conversationKey: target.entry.conversationKey,
                    groupId: section.id,
                  });
                });
            }}
          >
            <TextField
              label={t("workspace.sectionName")}
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              required
              maxLength={200}
            />
            <Button type="submit" loading={task.busy} disabled={!peer || !name.trim()}>
              {t("workspace.newSection")}
            </Button>
          </form>
        </>
      )}
      {task.error && (
        <p role="alert" className={styles.error}>
          {t(task.error)}
        </p>
      )}
    </Overlay>
  );
}
