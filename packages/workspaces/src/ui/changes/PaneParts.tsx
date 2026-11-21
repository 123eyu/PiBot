import { useComboboxText, useT } from "@pibot/renderer-kit";
import { Button, Combobox, Icon, IconTile, type IconTileProps, SegmentedControl } from "@pibot/ui";
import type { ChangesStatus, ChangesTarget } from "@pibot/workspaces-contract/full";
import { type ReactNode, useEffect, useId, useRef } from "react";
import styles from "./changes.module.css";
import { formatCount } from "./diff/FileList.tsx";
import { GitRemoteActions } from "./history/GitRemoteActions.tsx";
import { ChangesIcon } from "./icons.tsx";
import type { ChangesScopeName, FileTag } from "./model.ts";

export function RepoBar({
  status,
  rootId,
  selectRoot,
  running,
  botName,
  actions,
  openRefs,
  target,
  busy = false,
  refresh,
}: {
  status?: ChangesStatus;
  rootId?: string;
  selectRoot(id: string | undefined): void;
  running: boolean;
  botName: string;
  actions?: ReactNode;
  openRefs?(): void;
  target?: ChangesTarget;
  busy?: boolean;
  refresh?(): void;
}) {
  const t = useT(),
    comboText = useComboboxText();
  if (!status) return <div className={styles.repo} />;
  const rootName = (root: ChangesStatus["root"]) =>
    root.id === "home"
      ? t(
          target?.conversationKey.startsWith("group:")
            ? "changes.repo.groupFolder"
            : "changes.repo.ownFolder",
        )
      : root.name;
  const git = status.git,
    roots = status.roots.filter((root) => root.kind !== "worktree"),
    primary = roots.find((root) => root.role === "primary"),
    selectedOrdinary = roots.some((root) => root.id === status.root.id);
  return (
    <div className={styles.repo}>
      <div className={styles.repoSummary}>
        <div className={styles.repoContext}>
          <span className={styles.repoFolder} title={status.root.path}>
            {selectedOrdinary && roots.length > 1 ? (
              <Combobox
                {...comboText}
                hideLabel
                variant="pill"
                label={t("changes.repo.folder")}
                placeholder={t("changes.repo.folder")}
                value={rootId ?? primary?.id ?? ""}
                options={roots.map((root) => ({
                  value: root.id,
                  label:
                    root.role === "readonly"
                      ? t("changes.repo.readonlyOption", { name: rootName(root) })
                      : rootName(root),
                }))}
                onValueChange={(value) => selectRoot(value === primary?.id ? undefined : value)}
              />
            ) : (
              <span className={styles.rootName}>
                <Icon name="folder" size={13} />
                <span>{rootName(status.root)}</span>
              </span>
            )}
          </span>
          {status.root.role === "readonly" && (
            <span className={styles.pill}>
              <ChangesIcon name="lock" size={12} />
              {t("changes.repo.readonly")}
            </span>
          )}
          {running && (
            <span className={styles.pillAccent}>
              <span className={styles.spin} aria-hidden="true" />
              {t("changes.repo.running", { name: botName })}
            </span>
          )}
        </div>
        {git.state === "repo" ? (
          <div className={styles.repoBranchRow}>
            <Button
              variant="ghost"
              className={styles.branch}
              onClick={openRefs}
              aria-label={t("changes.refs.title")}
              title={`${t("changes.refs.title")} · ${git.branch ?? t("changes.repo.detached")}`}
            >
              <ChangesIcon name="branch" />
              <span className={styles.branchName}>{git.branch ?? t("changes.repo.detached")}</span>
              <ChangesIcon name="down" size={11} />
            </Button>
            <Upstream upstream={git.upstream} />
          </div>
        ) : (
          <span className={styles.pill}>
            {t(git.reason === "git_unavailable" ? "changes.repo.noGit" : "changes.repo.notRepo")}
          </span>
        )}
      </div>
      {(actions || (target && git.state === "repo")) && (
        <div className={styles.repoActions}>
          {actions}
          {target && git.state === "repo" && (
            <GitRemoteActions
              key={JSON.stringify([target, status.root.path])}
              target={target}
              status={status}
              disabled={busy || running}
              refresh={refresh}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** "· N commits ahead of the remote" from local refs only; nothing when in sync or no upstream. */
function Upstream({ upstream }: { upstream?: { ahead: number; behind: number } | null }) {
  const t = useT();
  if (!upstream || (!upstream.ahead && !upstream.behind)) return null;
  const text =
    upstream.ahead && upstream.behind
      ? t("changes.repo.aheadBehind", {
          ahead: formatCount(upstream.ahead),
          behind: formatCount(upstream.behind),
        })
      : upstream.ahead
        ? t("changes.repo.ahead", { count: formatCount(upstream.ahead) })
        : t("changes.repo.behind", { count: formatCount(upstream.behind) });
  return (
    <span className={styles.upstream} title={t("changes.repo.upstreamTitle")}>
      {text}
    </span>
  );
}

export function ScopeBar({
  scope,
  setScope,
  repo,
  counts,
  review,
}: {
  scope: ChangesScopeName;
  setScope(scope: ChangesScopeName): void;
  repo: boolean;
  counts: { uncommitted?: number; turn?: number };
  review?: ReactNode;
}) {
  const t = useT();
  const label = (key: "changes.scope.uncommitted" | "changes.scope.turn", count?: number) =>
    count === undefined ? t(key) : `${t(key)} ${formatCount(count)}`;
  const options = repo
    ? [
        {
          value: "uncommitted" as const,
          label: label("changes.scope.uncommitted", counts.uncommitted),
        },
        { value: "turn" as const, label: label("changes.scope.turn", counts.turn) },
        { value: "history" as const, label: t("changes.scope.history") },
      ]
    : [{ value: "turn" as const, label: label("changes.scope.turn", counts.turn) }];
  return (
    <div className={styles.scope}>
      <SegmentedControl
        label={t("changes.scope.label")}
        className={styles.segments}
        options={options}
        value={scope}
        onValueChange={setScope}
      />
      <span className={styles.grow} />
      {review}
    </div>
  );
}

export function Notice({
  tone,
  children,
}: {
  tone: "info" | "warn" | "accent";
  children: ReactNode;
}) {
  return (
    <div
      className={
        tone === "warn"
          ? styles.bannerWarn
          : tone === "accent"
            ? styles.bannerAccent
            : styles.bannerInfo
      }
    >
      {children}
    </div>
  );
}

/** Empty state: a coloured tile, the bold title, then the note and any action. */
export function Empty({
  title,
  children,
  icon = "check",
  tone = "green",
}: {
  title: string;
  children?: ReactNode;
  icon?: IconTileProps["icon"];
  tone?: IconTileProps["tone"];
}) {
  return (
    <div className={styles.empty}>
      <IconTile icon={icon} tone={tone} size="lg" className={styles.emptyTile} />
      <b>{title}</b>
      {children}
    </div>
  );
}

export function Skeleton({ slow }: { slow: boolean }) {
  const t = useT();
  return (
    <div className={styles.skeleton} role="status" aria-label={t("common.loading")}>
      <i style={{ width: "40%" }} />
      <i style={{ width: "85%" }} />
      <i style={{ width: "70%" }} />
      <i style={{ width: "78%" }} />
      {slow && <p className={styles.footNote}>{t("changes.loadingSlow")}</p>}
    </div>
  );
}

export interface DiscardRequest {
  key: string;
  display: string;
  tag: FileTag;
  hunk?: { index: number; digest: string };
  /** One object of a Word / Excel / PowerPoint file, with the newer side it was read from. */
  office?: { item: string; digest: string };
}

export function ConfirmDiscard({
  request,
  busy,
  cancel,
  confirm,
}: {
  request: DiscardRequest;
  busy: boolean;
  cancel(): void;
  confirm(): void;
}) {
  const t = useT();
  const id = useId();
  const cancelButton = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelButton.current?.focus(), []);
  const name = request.display.split("/").pop() ?? request.display;
  const body = request.office
    ? t("changes.discard.officeBody")
    : request.hunk
      ? t("changes.discard.hunkBody")
      : request.tag === "A" || request.tag === "U"
        ? t("changes.discard.newBody")
        : request.tag === "D"
          ? t("changes.discard.deletedBody")
          : t("changes.discard.fileBody");
  return (
    <div
      className={styles.overlay}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={id}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <div className={styles.dialog}>
        <b id={id}>
          {request.office
            ? t("changes.discard.officeTitle")
            : request.hunk
              ? t("changes.discard.hunkTitle")
              : t("changes.discard.fileTitle", { name })}
        </b>
        <p className={styles.mono}>{request.display}</p>
        <p>{body}</p>
        <div className={styles.dialogActions}>
          <Button ref={cancelButton} variant="secondary" disabled={busy} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button className={styles.dangerButton} loading={busy} onClick={confirm}>
            {request.tag === "A" || request.tag === "U"
              ? t("changes.discard.delete")
              : t("changes.discard.confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Pending comments and open review findings; findings alone turn the button into "Fix all". */
export function CommentsBar({
  count,
  findings,
  botName,
  sending,
  clear,
  send,
}: {
  count: number;
  findings: number;
  botName: string;
  sending: boolean;
  clear(): void;
  send(): void;
}) {
  const t = useT();
  const parts = [
    count ? t("changes.comment.count", { count }) : "",
    findings ? t("changes.review.count", { count: findings }) : "",
  ].filter(Boolean);
  return (
    <div className={styles.commentsBar}>
      <ChangesIcon name="comment" />
      <span>{parts.join(" · ")}</span>
      {count > 0 && (
        <button type="button" className={styles.miniGhostAccent} disabled={sending} onClick={clear}>
          {t("changes.comment.clear")}
        </button>
      )}
      <Button className={styles.smallPrimary} loading={sending} onClick={send}>
        {count ? t("changes.comment.send", { name: botName }) : t("changes.review.fixAll")}
      </Button>
    </div>
  );
}
