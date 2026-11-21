import { Button, Icon, IconTile } from "@pibot/ui";
import type { MethodResults } from "@pibot/workspaces-contract/full";
import { useEffect, useRef, useState } from "react";
import { useWorkspaceExecution as useExecution } from "../shell/ports.tsx";
import styles from "./changes.module.css";
import { useChangesLink } from "./context.ts";
import { DiffView } from "./diff/DiffView.tsx";
import { GitRefsPanel } from "./history/GitRefsPanel.tsx";
import { History } from "./history/History.tsx";
import { ChangesIcon } from "./icons.tsx";
import { baseName, joinRoot } from "./model.ts";
import { ConfirmDiscard, Empty, RepoBar, ScopeBar, Skeleton } from "./PaneParts.tsx";
import { Footer, Notices, ScopeList } from "./PaneSections.tsx";
import { ChangesEvidenceView, type EvidenceScope } from "./review/ChangesEvidenceView.tsx";
import evidenceStyles from "./review/changes-evidence.module.css";
import { ReviewerMenu } from "./review/ReviewerMenu.tsx";
import {
  type ChangesPaneModel,
  type ChangesPaneOptions,
  useChangesPane,
} from "./use-changes-pane.ts";
import { ManagedResourcesPanel, WorkspaceResources } from "./worktrees/ManagedResourcesPanel.tsx";

export type { ChangesRequest } from "./use-changes-pane.ts";

/** Legacy findings remain useful comments, but cannot attest to an immutable current version. */
function ReviewButton({ model }: { model: ChangesPaneModel }) {
  const { t } = model;
  const list = model.reviewers.list;
  // Buttons name the Bot that will review, not always the one that wrote the code.
  const botName = list?.bots.find((bot) => bot.id === list.reviewerId)?.name ?? model.botName;
  const picker = list && (
    <ReviewerMenu
      list={list}
      authorName={model.botName}
      disabled={model.busy}
      onPick={(choice) => void model.review(choice)}
      onCreate={() => void model.reviewWithBuiltin()}
      onOpen={() => void model.reviewers.reload()}
    />
  );
  if (model.reviewing)
    return (
      <span className={styles.reviewing} role="status">
        {t("agentReview.requested")}
      </span>
    );
  if (model.reviews.freshness !== "current" && model.reviews.history.length)
    return (
      <span className={styles.reviewActions}>
        <button
          type="button"
          className={styles.mini}
          aria-expanded={model.reviews.historyOpen}
          title={t(`agentReview.freshness.${model.reviews.freshness}`)}
          onClick={model.reviews.toggleHistory}
        >
          {t("agentReview.historyCount", { count: model.reviews.history.length })}
        </button>
        <span role="status">{t(`agentReview.freshness.${model.reviews.freshness}`)}</span>
        {model.files.length > 0 && (
          <button
            type="button"
            className={styles.miniGhostAccent}
            disabled={model.busy}
            onClick={() => void model.review()}
          >
            {t("changes.review.again")}
          </button>
        )}
        {model.files.length > 0 && picker}
      </span>
    );
  const found = model.reviews.open.length;
  const again = (title: string) => (
    <button
      type="button"
      className={styles.miniGhostAccent}
      disabled={model.busy}
      title={title}
      onClick={() => void model.review()}
    >
      {t("changes.review.again")}
    </button>
  );
  // Open findings used to take the button's place, so a new review needed every old finding
  // ignored or fixed first. A new review is the newest one and replaces them once it finishes.
  if (found > 0)
    return (
      <span className={styles.reviewActions}>
        <button
          type="button"
          className={`${styles.mini} ${styles.miniWarn}`}
          title={
            model.reviews.reviewerName
              ? t("changes.review.by", { name: model.reviews.reviewerName })
              : t("agentReview.legacy")
          }
          disabled={!model.reviews.firstFile}
          onClick={model.jumpToFinding}
        >
          <ChangesIcon name="sparkle" />
          {t("agentReview.legacyCount", { count: found })}
        </button>
        {again(t("changes.review.againTitle", { name: botName }))}
        {picker}
      </span>
    );
  // The newest review finished without findings: say so instead of falling back to the plain
  // button, which would look as if no review had run.
  if (model.reviews.clean)
    return (
      <span className={styles.reviewActions}>
        <span role="status">
          {model.reviews.reviewerName
            ? t("changes.review.cleanBy", { name: model.reviews.reviewerName })
            : t("agentReview.legacyClean")}
        </span>
        {again(t("changes.review.title", { name: botName }))}
        {picker}
      </span>
    );
  const plain = (
    <button
      type="button"
      className={styles.mini}
      disabled={model.busy}
      title={t("changes.review.title", { name: botName })}
      onClick={() => void model.review()}
    >
      <ChangesIcon name="sparkle" />
      {t("changes.review.action", { name: botName })}
    </button>
  );
  return picker ? (
    <span className={styles.reviewSplit}>
      {plain}
      {picker}
    </span>
  ) : (
    plain
  );
}

function isTyping(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

/** The changes sidebar: scopes, file list, diff, comments, discard and commit. */
export function ChangesPane({
  wide,
  active,
  ownerBotId,
  ...options
}: ChangesPaneOptions & { wide: boolean; active: boolean; ownerBotId?: string }) {
  const model = useChangesPane(options);
  const execution = useExecution();
  const link = useChangesLink();
  const [refsOpen, setRefsOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceScope>();
  const evidenceButton = useRef<HTMLButtonElement>(null);
  const returnToEvidence = useRef(false);
  const routeKey = JSON.stringify([options.conversationKey, options.topicId]);
  // Evidence and management views belong to the topic that opened them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: canonical route identity owns all subviews.
  useEffect(() => {
    setEvidence(undefined);
    setResourcesOpen(false);
    setRefsOpen(false);
    returnToEvidence.current = false;
  }, [routeKey]);
  useEffect(() => {
    if (!evidence && returnToEvidence.current) {
      evidenceButton.current?.focus({ preventScroll: true });
      returnToEvidence.current = false;
    }
  }, [evidence]);
  const showReview = (receipt: MethodResults["worktrees.review"]) => setEvidence(receipt);
  const { t, file, view, step, scope } = model;
  // J / K move between files whenever a file is on screen.
  useEffect(() => {
    if (!active || (!wide && view !== "diff")) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        step(event.key === "j" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, wide, view, step]);
  // Wide layout always shows a file on the right when there is one.
  const first = model.order[0];
  useEffect(() => {
    if (wide && !file && first) model.setSelected(first.key);
  }, [wide, file, first, model.setSelected]);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!model.state.loading) return setSlow(false);
    const timer = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(timer);
  }, [model.state.loading]);

  const status = model.status;
  if (!status)
    return (
      <div className={styles.pane}>
        {model.state.error ? (
          <Empty title={t("changes.error.title")} icon="warning" tone="red">
            <span>{t(model.state.error)}</span>
            <Button variant="secondary" onClick={() => model.source?.refresh()}>
              {t("common.retry")}
            </Button>
          </Empty>
        ) : (
          <Skeleton slow={slow} />
        )}
      </div>
    );
  const openFile =
    file && ownerBotId && file.tag !== "D"
      ? () =>
          void options.peer
            .call("files.open", {
              botId: ownerBotId,
              path: scope === "turn" ? file.key : joinRoot(status.root.path, file.display),
            })
            .catch(() => model.setNotice({ key: "changes.error.open", error: true }))
      : undefined;
  const turnRun = model.turn.runId;
  const preview = link?.preview;
  const previewFile =
    file && scope === "turn" && file.previewable && turnRun && preview
      ? () => preview({ name: baseName(file.display), source: { runId: turnRun, path: file.key } })
      : undefined;
  const diff = file && (wide || view === "diff") && (
    <DiffView
      file={file}
      state={model.diff.state}
      index={model.index.get(file.key) ?? 0}
      total={model.order.length}
      wide={wide}
      commentable={model.commentable}
      editable={model.editable}
      writable={model.writable}
      stale={model.staleAt === file.key}
      // In a repository subdirectory paths are relative to the folder, not the repo root.
      rootLabel={t(
        model.repo && !(model.git?.state === "repo" && model.git.subdirectory)
          ? "changes.diff.repoRoot"
          : "changes.diff.folderRoot",
      )}
      comments={model.comments.filter((comment) => comment.fileKey === file.key)}
      editing={model.editing}
      botName={model.botName}
      {...(model.reviews.reviewerName ? { reviewerName: model.reviews.reviewerName } : {})}
      findings={model.reviews.perFile.get(file.key) ?? []}
      revealFinding={model.revealFinding}
      busy={model.busy}
      expansion={model.expansion}
      loadImage={model.loadImage}
      actions={{
        finding: model.findingActions,
        back: () => model.setView("list"),
        step,
        line: model.lineComment,
        fileComment: () =>
          model.setEditing({
            fileKey: file.key,
            display: file.display,
            side: "file",
            from: 0,
            to: 0,
          }),
        saveComment: model.saveComment,
        cancelComment: () => model.setEditing(undefined),
        deleteComment: (id) =>
          model.updateComments((current) => current.filter((c) => c.id !== id)),
        discardFile: () =>
          model.setConfirm({ key: file.key, display: file.display, tag: file.tag }),
        discardHunk: model.discardHunk,
        discardOffice: model.discardOffice,
        openFile,
        previewFile,
        retry: model.diff.retry,
      }}
    />
  );
  if (evidence)
    return (
      <ChangesEvidenceView
        key={JSON.stringify(evidence)}
        scope={evidence}
        members={execution?.topics ?? []}
        back={() => setEvidence(undefined)}
      />
    );
  if (refsOpen)
    return (
      <GitRefsPanel
        key={JSON.stringify(model.target)}
        model={model}
        back={() => setRefsOpen(false)}
      />
    );
  if (resourcesOpen)
    return (
      <WorkspaceResources
        model={model}
        back={() => setResourcesOpen(false)}
        onReview={showReview}
      />
    );
  const list = <ScopeList model={model} />;
  return (
    <div className={styles.pane}>
      <RepoBar
        status={status}
        rootId={model.rootId}
        selectRoot={model.setRootId}
        running={model.running}
        botName={model.runningName}
        openRefs={() => setRefsOpen(true)}
        target={model.target}
        busy={model.busy}
        refresh={() => model.source?.refresh()}
        actions={<ManagedResourcesPanel model={model} open={() => setResourcesOpen(true)} />}
      />
      <ScopeBar
        scope={scope}
        setScope={model.setScope}
        repo={model.repo}
        counts={{
          uncommitted: model.repo ? status.total : undefined,
          turn: model.turnCount,
        }}
        review={
          scope !== "history" &&
          status.root.kind !== "worktree" &&
          (model.files.length > 0 || model.reviews.history.length > 0) ? (
            <ReviewButton model={model} />
          ) : undefined
        }
      />
      {model.reviews.historyOpen && model.reviews.history.length > 0 && (
        <section
          className={styles.reviewHistory}
          aria-label={model.t("agentReview.historicalFindings")}
        >
          <p>{model.t("agentReview.historyExplanation")}</p>
          {model.reviews.history.map((finding) => (
            <article key={finding.id}>
              <strong>
                {finding.path}
                {finding.line ? `:${finding.line}` : ""}
              </strong>
              <p>{finding.message}</p>
            </article>
          ))}
        </section>
      )}
      {/* A single open file gets the height; the notices describe the list. */}
      {(wide || view !== "diff" || !file) && <Notices model={model} />}
      <div className={styles.body} data-wide={wide || undefined}>
        {scope === "history" && !model.commit ? (
          <History
            peer={options.peer}
            target={model.target}
            revision={`${model.historyRevision}:${model.git?.state === "repo" ? model.git.head : ""}`}
            open={model.setCommit}
          />
        ) : wide ? (
          <>
            <div className={styles.listColumn}>{list}</div>
            <div className={styles.diffColumn}>
              {diff || <p className={styles.listEmpty}>{t("changes.diff.pick")}</p>}
            </div>
          </>
        ) : (
          diff || <div className={styles.listColumn}>{list}</div>
        )}
      </div>
      <Footer model={model} />
      {execution?.conversationId && execution.topics.length > 0 && (
        <button
          ref={evidenceButton}
          type="button"
          className={evidenceStyles.entry}
          onClick={() => {
            if (!execution.conversationId) return;
            returnToEvidence.current = true;
            setEvidence({
              conversationId: execution.conversationId,
              rootId: status.root.id,
              path: status.root.path,
            });
          }}
        >
          <span>
            <IconTile icon="audit" tone="violet" size="sm" />
            {t("agentReview.title")}
          </span>
          <Icon name="chevronRight" size={14} />
        </button>
      )}
      {model.confirm && (
        <ConfirmDiscard
          request={model.confirm}
          busy={model.busy}
          cancel={() => model.setConfirm(undefined)}
          confirm={() => void model.discard()}
        />
      )}
    </div>
  );
}
