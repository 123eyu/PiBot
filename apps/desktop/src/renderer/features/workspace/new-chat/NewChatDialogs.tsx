import { Overlay, useNavigation, useT } from "@pibot/renderer-kit";
import { RoleCreate, RolePicker, TemplateList } from "@pibot/teams/ui";
import { Button } from "@pibot/ui";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { CustomBotCreate } from "./CustomBotCreate.tsx";
import { MemberPicker } from "./MemberPicker.tsx";
import { NewChatGroupForm } from "./NewChatGroupForm.tsx";
import styles from "./new-chat.module.css";
import {
  NEW_CHAT_DIALOG,
  type NewChatDialogKind,
  type RoleImportTarget,
} from "./new-chat-dialog.ts";
import { type NewBotState, useNewBot } from "./use-new-bot.ts";
import { type NewGroupState, useNewGroup } from "./use-new-group.ts";

/**
 * Maintainers 2026-11-13: the ＋ menu's 新建 Bot / 新建群聊 open here, over the current screen. Creating
 * navigates to the new chat, which closes the dialog with every other shell dialog.
 */
export function NewChatDialogs() {
  const { dialog, closeDialog, teamOverlay } = useNavigation();
  const open = dialog?.owner === NEW_CHAT_DIALOG ? dialog : undefined;
  // The import, template and profession dialogs replace this one instead of stacking on it.
  const overlayAtOpen = useRef(teamOverlay);
  const openKey = open?.key;
  useEffect(() => {
    const previous = overlayAtOpen.current;
    overlayAtOpen.current = teamOverlay;
    if (openKey && teamOverlay && teamOverlay !== previous) closeDialog(openKey);
  }, [openKey, teamOverlay, closeDialog]);
  if (!open) return null;
  const close = () => closeDialog(open.key);
  const state = open.state as
    | NewChatDialogKind
    | { kind: NewChatDialogKind; target: RoleImportTarget };
  const kind = typeof state === "string" ? state : state.kind;
  const target = typeof state === "string" ? undefined : state.target;
  return kind === "group" ? (
    <NewGroupDialog key={open.key} close={close} target={target} />
  ) : (
    <NewBotDialog key={open.key} close={close} target={target} />
  );
}

function NewBotDialog({ close, target }: { close(): void; target?: RoleImportTarget }) {
  const t = useT();
  const state = useNewBot();
  const id = useId();
  const description = useRef<HTMLTextAreaElement>(null);
  const { navigate } = useNavigation();
  useEffect(() => {
    if (state.role === "custom") description.current?.focus({ preventScroll: true });
  }, [state.role]);
  const selected = state.category === "image" ? state.selectedImageModel : state.selectedModel;
  const blocked = state.uncertain
    ? "workspace.createUncertain"
    : !state.description.trim()
      ? "workspace.jobRequired"
      : !selected
        ? "models.selectModel"
        : undefined;
  return (
    <Overlay
      footer={
        state.role === "custom" && (
          <div className={styles.botFooter}>
            <span>{blocked && t(blocked)}</span>
            <Button variant="secondary" disabled={state.task.busy} onClick={close}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" form={id} loading={state.task.busy} disabled={Boolean(blocked)}>
              {t("workspace.createStart")}
            </Button>
          </div>
        )
      }
      icon="bot"
      tone="violet"
      // The role list is the first page; its own heading moves into the frame (one title, as drawn).
      title={t(state.role === undefined ? "builtin.role.title" : "workspace.newBot")}
      close={close}
      busy={state.task.busy}
    >
      {state.role === undefined && (
        <RolePicker
          hideTitle
          target={target?.kind === "role" ? { ...target, kind: "role" } : undefined}
          onCustom={() => state.setRole("custom")}
          onPick={state.setRole}
        />
      )}
      {state.role && state.role !== "custom" && (
        <RoleCreate
          key={state.role.id}
          role={state.role}
          onBack={() => state.setRole(undefined)}
          onCreated={(bot) => {
            navigate({ name: "chat", botId: bot.id });
            void state.data.refresh();
          }}
        />
      )}
      {state.role === "custom" && (
        <CustomBotCreate state={state} id={id} description={description} />
      )}
      <BotFeedback state={state} close={close} />
    </Overlay>
  );
}

function BotFeedback({ state, close }: { state: NewBotState; close(): void }) {
  const t = useT();
  return (
    <Feedback state={state} close={close}>
      {state.role === "custom" && state.catalog.loading && (
        <p role="status">{t("common.loading")}</p>
      )}
      {state.role === "custom" && state.catalog.error && (
        <p role="alert" className={styles.error}>
          {t("workspace.failed")}{" "}
          <Button variant="ghost" onClick={state.catalog.reload}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {state.longWait && state.task.busy && (
        <p role="status" className={styles.hint}>
          {t("workspace.keychainWait")}
        </p>
      )}
    </Feedback>
  );
}

function NewGroupDialog({ close, target }: { close(): void; target?: RoleImportTarget }) {
  const t = useT();
  const state = useNewGroup();
  const id = useId();
  const blocked = state.uncertain
    ? "workspace.createUncertain"
    : state.picked.length < 2 || state.selectedBots.length !== state.picked.length
      ? "workspace.groupMinimum"
      : !state.coordinatorId
        ? "workspace.groupCoordinatorRequired"
        : undefined;
  return (
    <Overlay
      footer={
        <div className={styles.groupFooter}>
          <span>{blocked && t(blocked)}</span>
          <Button variant="secondary" disabled={state.task.busy} onClick={close}>
            {t("workspace.groupBack")}
          </Button>
          <Button type="submit" form={id} loading={state.task.busy} disabled={Boolean(blocked)}>
            {t("workspace.createGroupCount", { count: state.picked.length })}
          </Button>
        </div>
      }
      icon="users"
      tone="teal"
      title={t("workspace.newGroup")}
      close={close}
      busy={state.task.busy}
    >
      <TemplateList
        query=""
        disabled={state.task.busy}
        target={target?.kind === "group" ? { ...target, kind: "group" } : undefined}
      />
      <section
        className={`${styles.members} ${styles.formCard} ${styles.groupAccent}`}
        aria-label={t("workspace.members")}
      >
        <h2 className={styles.cardTitle}>
          {t("workspace.membersPicked", { count: state.picked.length })}
        </h2>
        <p className={styles.banner}>{t("workspace.groupHint")}</p>
        <MemberPicker state={state} />
      </section>
      <NewChatGroupForm state={state} id={id} />
      <Feedback state={state} close={close} />
    </Overlay>
  );
}

/** Load, failure and "may have been created" states shared by both dialogs. */
function Feedback({
  state,
  close,
  children,
}: {
  state: NewBotState | NewGroupState;
  close(): void;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <div className={styles.dialogFeedback}>
      {state.data.loading && <p role="status">{t("common.loading")}</p>}
      {state.data.error && (
        <p role="alert" className={styles.error}>
          {t("workspace.failed")}{" "}
          <Button variant="ghost" onClick={() => void state.data.refresh()}>
            {t("common.retry")}
          </Button>
        </p>
      )}
      {children}
      {state.task.error && (
        <p
          role={state.uncertain ? "status" : "alert"}
          className={state.uncertain ? styles.hint : styles.error}
        >
          {t(state.task.error)}
        </p>
      )}
      {state.uncertain && (
        <Button
          variant="secondary"
          onClick={() => {
            close();
            void state.data.refresh();
          }}
        >
          {t("workspace.refresh")}
        </Button>
      )}
    </div>
  );
}
