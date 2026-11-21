import type { TranslationKey } from "@pibot/i18n";
import { useComboboxText, useT } from "@pibot/renderer-kit";
import { Button, Combobox, Icon, IconButton } from "@pibot/ui";
import type { ChangesStatus, ChangesTarget } from "@pibot/workspaces-contract/full";
import { useEffect, useId, useRef } from "react";
import styles from "./GitRemoteActions.module.css";
import { type GitRemoteState, useGitRemote } from "./use-git-remote.ts";

export function GitRemoteActions({
  target,
  status,
  disabled,
  refresh,
}: {
  target: ChangesTarget;
  status: ChangesStatus;
  disabled: boolean;
  refresh?(): void;
}) {
  const state = useGitRemote(target, status, refresh);
  return <GitRemoteToolbar state={state} status={status} disabled={disabled} />;
}
/** Shared production view also serves isolated React visual fixtures without a live RPC peer. */
export function GitRemoteToolbar({
  state,
  status,
  disabled,
}: {
  state: GitRemoteState;
  status: ChangesStatus;
  disabled: boolean;
}) {
  const t = useT(),
    data = state.data;
  const readonly =
    status.root.role !== "primary" ||
    (status.git.state === "repo" && !status.git.writable) ||
    (data && !data.writable);
  const blocked = disabled || state.busy || state.loading || !!readonly;
  const reason = readonly
    ? t("changes.repo.readonly")
    : disabled
      ? t("changes.error.changes_busy")
      : state.busy
        ? t("changes.remote.working")
        : state.loading
          ? t("common.loading")
          : undefined;
  return (
    <div className={styles.controls}>
      <fieldset className={styles.toolbar} aria-label={t("changes.remote.toolbar")}>
        {!!data?.remotes.length && (
          <>
            <RemoteAction
              label={t("changes.remote.push")}
              reason={reason}
              disabled={blocked}
              onClick={() => void state.open("push")}
              direction="push"
            />
            <RemoteAction
              label={t("changes.remote.pull")}
              reason={reason}
              disabled={blocked}
              onClick={() => void state.open("pull")}
              direction="pull"
            />
          </>
        )}
        {state.loading && (
          <span className={styles.progress} role="status" aria-label={t("common.loading")}>
            <span />
          </span>
        )}
        {state.busy && (
          <span className={styles.progress} role="status" aria-label={t("changes.remote.working")}>
            <span />
          </span>
        )}
        {state.error && !state.dialog && (
          <IconButton
            variant="ghost"
            className={styles.failure}
            label={t(state.error)}
            title={t(state.error)}
            disabled={state.busy || state.loading}
            onClick={() => void state.reload()}
          >
            <Icon name="warning" size={16} />
          </IconButton>
        )}
        {state.done && (
          <span
            role="status"
            className={styles.done}
            title={t(state.done === "push" ? "changes.remote.pushed" : "changes.remote.pulled")}
            aria-label={t(
              state.done === "push" ? "changes.remote.pushed" : "changes.remote.pulled",
            )}
          >
            <Icon name="check" size={14} />
          </span>
        )}
      </fieldset>
      {state.error && !state.dialog && (
        <p className={styles.error} role="alert">
          {t(state.error)}{" "}
          <Button
            variant="ghost"
            disabled={state.busy || state.loading}
            onClick={() => void state.reload()}
          >
            {t("changes.remote.refresh")}
          </Button>
        </p>
      )}
      {state.dialog && (
        <RemoteDialog
          state={state}
          blockedReason={
            readonly
              ? "changes.repo.readonly"
              : disabled
                ? "changes.error.changes_busy"
                : status.total > 0
                  ? "changes.error.changes_remote_dirty"
                  : undefined
          }
        />
      )}
    </div>
  );
}
function RemoteAction({
  label,
  reason,
  direction,
  disabled,
  onClick,
}: {
  label: string;
  reason?: string;
  direction: "push" | "pull";
  disabled: boolean;
  onClick(): void;
}) {
  const title = [label, reason].filter(Boolean).join(" · ");
  return (
    <span className={styles.actionHint} title={title}>
      <IconButton
        variant="ghost"
        className={styles.action}
        label={label}
        title={title}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon
          name="arrow"
          size={16}
          style={{ transform: direction === "push" ? "rotate(-90deg)" : "rotate(90deg)" }}
        />
      </IconButton>
    </span>
  );
}

function RemoteDialog({
  state,
  blockedReason,
}: {
  state: GitRemoteState;
  blockedReason?: TranslationKey;
}) {
  const t = useT(),
    id = useId(),
    dialog = useRef<HTMLDialogElement>(null),
    cancel = useRef<HTMLButtonElement>(null),
    comboText = useComboboxText(),
    confirmation = state.dialog;
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    cancel.current?.focus();
    return () => {
      if (element?.open) element.close();
    };
  }, []);
  if (!confirmation) return null;
  const { action, snapshot, remote: selected } = confirmation;
  const remote = snapshot.remotes.find((item) => item.name === selected),
    supported = action === "push" ? remote?.pushSupported : remote?.fetchSupported;
  const branch =
    snapshot.upstream?.remote === selected ? snapshot.upstream.branch : snapshot.branch;
  const upstream =
    action === "push" ||
    (snapshot.upstream?.remote === selected && snapshot.upstream.branch === branch);
  const allowed =
    !blockedReason &&
    snapshot.writable &&
    !!snapshot.head &&
    !!snapshot.branch &&
    !!remote &&
    supported &&
    upstream;
  const host = action === "push" ? remote?.pushHost : remote?.fetchHost;
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        if (!state.busy) state.close();
      }}
    >
      <h3 id={id}>
        {t(action === "push" ? "changes.remote.pushTitle" : "changes.remote.pullTitle")}
      </h3>
      {/* C-push: the remote is a pill picker, like the other choices in the pane. */}
      <div className={styles.field}>
        <span>{t("changes.remote.remote")}</span>
        <Combobox
          {...comboText}
          hideLabel
          variant="pill"
          label={t("changes.remote.remote")}
          placeholder={t("changes.remote.choose")}
          value={selected}
          disabled={state.busy}
          onValueChange={(value) => state.setDialog({ ...confirmation, remote: value })}
          options={snapshot.remotes.map((item) => ({
            value: item.name,
            label: item.name,
            secondary: (action === "push" ? item.pushHost : item.fetchHost) || undefined,
          }))}
        />
      </div>
      <dl className={styles.details}>
        <div>
          <dt>{t("changes.remote.localBranch")}</dt>
          <dd title={snapshot.branch ?? ""}>{snapshot.branch ?? t("changes.repo.detached")}</dd>
        </div>
        <div>
          <dt>{t("changes.remote.commit")}</dt>
          <dd>{snapshot.head?.slice(0, 8) ?? "—"}</dd>
        </div>
        {remote && (
          <div>
            <dt>{t("changes.remote.target")}</dt>
            <dd title={`${remote.name}/${branch ?? ""}`}>
              {remote.name}/{branch ?? "—"}
              {host ? ` · ${host}` : ""}
            </dd>
          </div>
        )}
      </dl>
      <p>{t(action === "push" ? "changes.remote.pushBody" : "changes.remote.pullBody")}</p>
      {remote && !supported && (
        <p role="status" className={styles.error}>
          {t("changes.error.changes_remote_unsupported")}
        </p>
      )}
      {remote && supported && !upstream && (
        <p role="status" className={styles.error}>
          {t("changes.error.changes_remote_no_upstream")}
        </p>
      )}
      {blockedReason && (
        <p role="status" className={styles.error}>
          {t(blockedReason)}
        </p>
      )}
      <p className={styles.hint}>{t("changes.remote.support")}</p>
      <div className={styles.dialogActions}>
        <Button ref={cancel} variant="secondary" disabled={state.busy} onClick={state.close}>
          {t("common.cancel")}
        </Button>
        <Button disabled={!allowed} loading={state.busy} onClick={() => void state.confirm()}>
          {t(action === "push" ? "changes.remote.push" : "changes.remote.pull")}
        </Button>
      </div>
    </dialog>
  );
}
