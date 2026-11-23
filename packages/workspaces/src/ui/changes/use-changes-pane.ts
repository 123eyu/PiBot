import type { ChatPeer } from "@pibot/client-core";
import type { TranslationKey } from "@pibot/i18n";
import { useT } from "@pibot/renderer-kit";
import type {
  ChangeCommit,
  DiffHunk,
  GitIdentity,
  ReviewFinding,
} from "@pibot/workspaces-contract/full";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileListActions } from "./diff/FileList.tsx";
import { buildRows } from "./diff/file-rows.ts";
import { type ChangesScopeName, changesErrorKey, type ListFile } from "./model.ts";
import type { DiscardRequest } from "./PaneParts.tsx";
import { useDraftComments } from "./review/comment-store.ts";
import {
  type CommentAnchor,
  commentsMessage,
  findingsList,
  fixOneMessage,
  reviewMessage,
} from "./review/comments.ts";
import { useReviewers } from "./review/use-reviewers.ts";
import { useReviews } from "./review/use-reviews.ts";
import { type ChangesTarget, useChangesSource } from "./store.ts";
import { useExpansion } from "./use-expansion.ts";
import { useCommitFiles, useDiff, usePaneTurn } from "./use-pane-data.ts";

export interface ChangesRequest {
  scope: "uncommitted" | "turn";
  runId?: string;
  path?: string;
  /** Increments for every request so the same target can be opened twice. */
  seq: number;
}
export interface ChangesPaneOptions {
  peer: ChatPeer;
  conversationKey: string;
  topicId?: string;
  botName: string;
  runningName?: string;
  running: boolean;
  request?: ChangesRequest;
  send(text: string): Promise<boolean>;
}

const NO_FILES: readonly ListFile[] = [];

/** All sidebar state and actions; the component only lays them out. */
export function useChangesPane(options: ChangesPaneOptions) {
  const { peer, conversationKey, topicId, botName, running, request, send } = options;
  const t = useT();
  const [rootId, setRootId] = useState<string>();
  const target = useMemo<ChangesTarget>(
    () => ({ conversationKey, ...(topicId ? { topicId } : {}), ...(rootId ? { rootId } : {}) }),
    [conversationKey, topicId, rootId],
  );
  const { source, state } = useChangesSource(peer, target, true);
  useEffect(() => source?.wantAll(), [source]);
  const status = state.status;
  const git = status?.git;
  const repo = git?.state === "repo";
  const [scope, setScopeState] = useState<ChangesScopeName>(request?.scope ?? "uncommitted");
  const [turnRun, setTurnRun] = useState<string | undefined>(request?.runId);
  const [commit, setCommit] = useState<ChangeCommit>();
  const [selected, setSelected] = useState<string | undefined>(request?.path);
  const [view, setView] = useState<"list" | "diff">(request?.path ? "diff" : "list");
  const [query, setQuery] = useState("");
  const [tree, setTree] = useState(true);
  const [folders, setFolders] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [showAll, setShowAll] = useState<ReadonlySet<string>>(new Set());
  const [generatedOpen, setGeneratedOpen] = useState(false);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<CommentAnchor>();
  const [confirm, setConfirm] = useState<DiscardRequest>();
  /** The file whose per-object revert came back stale, so the list stops offering it. */
  const [staleAt, setStaleAt] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ key: TranslationKey; error: boolean }>();
  const [committed, setCommitted] = useState<{ oid: string; subject: string }>();
  const gitState = git?.state === "none" ? git.reason : (git?.state ?? "");
  useEffect(() => {
    if (gitState) setNotice(undefined);
  }, [gitState]);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [comments, updateComments] = useDraftComments(`${conversationKey}|${topicId ?? ""}`);

  const applied = useRef(request?.seq);
  useEffect(() => {
    if (!request || applied.current === request.seq) return;
    applied.current = request.seq;
    // The title-bar pill and reply cards both describe the primary folder.
    setRootId(undefined);
    setScopeState(request.scope);
    setTurnRun(request.runId);
    setCommit(undefined);
    setSelected(request.path);
    setView(request.path ? "diff" : "list");
    setEditing(undefined);
  }, [request]);
  // A folder that is not a repository only has "this turn".
  useEffect(() => {
    if (git && !repo && scope !== "turn") setScopeState("turn");
  }, [git, repo, scope]);

  useEffect(() => {
    let reading: AbortController | undefined;
    const off = peer.on("changes.changed", (event) => {
      if (
        event.reason !== "turn" ||
        (event.conversationKey && event.conversationKey !== conversationKey) ||
        (event.topicId && event.topicId !== topicId)
      )
        return;
      reading?.abort();
      const abort = new AbortController();
      reading = abort;
      // Turn-only pushes may name just a run. Confirm its topic before unpinning this pane.
      void peer
        .call(
          "changes.turn",
          { conversationKey, ...(topicId ? { topicId } : {}) },
          { signal: abort.signal, timeoutMs: 30_000 },
        )
        .then((latest) => {
          if (!abort.signal.aborted && latest.runId === event.runId) {
            setTurnRun(undefined);
            setSelected(undefined);
          }
        })
        .catch(() => {
          // An unconfirmed event must leave the last confirmed selection intact.
        });
    });
    return () => {
      reading?.abort();
      off();
    };
  }, [peer, conversationKey, topicId]);
  const turn = usePaneTurn(peer, target, turnRun);
  // A turn is recorded for the run's primary folder, so viewing an associated read-only folder
  // used to list the primary folder's files. Bots never write read-only folders, so this
  // turn has nothing there; the list explains that instead.
  const readonlyRoot = status?.root.role === "readonly";
  const turnFiles = readonlyRoot ? NO_FILES : turn.files;
  const commitFiles = useCommitFiles(peer, target, scope === "history" ? commit : undefined);
  const files: readonly ListFile[] =
    scope === "uncommitted"
      ? state.files
      : scope === "turn"
        ? turnFiles
        : commit
          ? commitFiles.files
          : [];
  const { rows, order, matched } = useMemo(
    () => buildRows(files, { query, tree, folders, showAll, generatedOpen }),
    [files, query, tree, folders, showAll, generatedOpen],
  );
  const byKey = useMemo(() => new Map(files.map((file) => [file.key, file])), [files]);
  const index = useMemo(() => new Map(order.map((file, at) => [file.key, at])), [order]);
  const file = selected ? byKey.get(selected) : undefined;
  const editable = scope === "uncommitted" && git?.state === "repo" && git.writable && !running;
  const commentable = scope !== "history" && status?.root.kind !== "worktree";
  const commentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const comment of comments)
      counts.set(comment.fileKey, (counts.get(comment.fileKey) ?? 0) + 1);
    return counts;
  }, [comments]);

  const diffSource =
    scope === "history" && commit
      ? ({ scope: "commit", commit: commit.oid } as const)
      : scope === "turn" && turn.runId
        ? ({ scope: "turn", runId: turn.runId, revision: turn.data } as const)
        : ({ scope: "uncommitted", revision: status } as const);
  const diff = useDiff(peer, target, diffSource, file);
  // Expandable unchanged lines, image thumbnails and review findings.
  const expansion = useExpansion(peer, target, diffSource, file, diff.state.data);
  const reviews = useReviews(peer, target, files, running);
  const reviewers = useReviewers(peer, target);
  const imageScope =
    diffSource.scope === "commit"
      ? { scope: "commit" as const, commit: diffSource.commit }
      : diffSource.scope === "turn"
        ? { scope: "turn" as const, runId: diffSource.runId }
        : { scope: "uncommitted" as const };
  const loadImage = file
    ? (side: "before" | "after", signal: AbortSignal) =>
        peer.call(
          "changes.image",
          { ...target, path: file.key, ...imageScope, side },
          { signal, timeoutMs: 30_000 },
        )
    : undefined;
  const [reviewAsked, setReviewAsked] = useState(false);
  // Bumped by "jump to the first finding"; the diff scrolls its first finding card into view.
  const [revealFinding, setRevealFinding] = useState(0);
  const sawRunning = useRef(false);
  // "Reviewing" lasts while the review run is going; a run that never starts stops showing it.
  useEffect(() => {
    if (!reviewAsked) return;
    if (running) {
      sawRunning.current = true;
      return;
    }
    if (sawRunning.current) {
      sawRunning.current = false;
      setReviewAsked(false);
      return;
    }
    const timer = setTimeout(() => setReviewAsked(false), 15_000);
    return () => clearTimeout(timer);
  }, [reviewAsked, running]);

  const setScope = useCallback((next: ChangesScopeName) => {
    setScopeState(next);
    setCommit(undefined);
    setSelected(undefined);
    setView("list");
    setEditing(undefined);
    if (next === "turn") setTurnRun(undefined);
  }, []);
  const open = useCallback((next: ListFile) => {
    setSelected(next.key);
    setView("diff");
  }, []);
  const step = useCallback(
    (delta: -1 | 1) => {
      const at = selected ? index.get(selected) : undefined;
      const next = order[at === undefined ? 0 : at + delta];
      if (next) {
        setSelected(next.key);
        setView("diff");
      }
    },
    [selected, index, order],
  );
  const flash = (key: TranslationKey, error = false) => setNotice({ key, error });
  // Confirmations fade after a few seconds; errors stay until the next action.
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(undefined), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const call = async <T>(work: () => Promise<T>) => {
    setBusy(true);
    setNotice(undefined);
    try {
      return await work();
    } catch (error) {
      flash(changesErrorKey(error), true);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    const request = confirm;
    if (!request) return;
    if (request.office) {
      setBusy(true);
      setNotice(undefined);
      try {
        await peer.call(
          "changes.discardOffice",
          {
            ...target,
            path: request.key,
            // Same version pair as the list the item came from (uncommitted / turn / commit).
            ...imageScope,
            item: request.office.item,
            digest: request.office.digest,
          },
          { timeoutMs: 200_000 },
        );
        setStaleAt(undefined);
        flash("changes.discard.doneOffice");
      } catch (error) {
        const key = changesErrorKey(error);
        flash(key, true);
        // The document changed elsewhere; the panel explains it and keeps the file-level action.
        if (key === "changes.error.changes_stale") setStaleAt(request.key);
      } finally {
        setConfirm(undefined);
        setBusy(false);
        source?.refresh();
      }
      return;
    }
    const done = await call(() =>
      peer.call(
        "changes.discard",
        { ...target, path: request.key, ...(request.hunk ? { hunk: request.hunk } : {}) },
        { timeoutMs: 200_000 },
      ),
    );
    setConfirm(undefined);
    if (done) flash(request.hunk ? "changes.discard.doneHunk" : "changes.discard.done");
    source?.refresh();
  };
  const commitNow = async (message: string, author?: GitIdentity) => {
    const paths = files.filter((entry) => !excluded.has(entry.key)).map((entry) => entry.key);
    const result = await peer
      .call(
        "changes.commit",
        { ...target, paths, message, ...(author ? { author } : {}) },
        { timeoutMs: 200_000 },
      )
      .catch((error: unknown) => {
        // Git removed under an open view: re-probe so the panel switches to the install card.
        if (changesErrorKey(error) === "changes.error.changes_git_unavailable") source?.refresh();
        throw error;
      });
    setCommitted({ oid: result.commit, subject: message.split("\n")[0] ?? "" });
    setExcluded(new Set());
    setSelected(undefined);
    setView("list");
    setHistoryRevision((value) => value + 1);
    source?.refresh();
  };
  const draft = (signal: AbortSignal) => {
    const paths = files
      .filter((entry) => !excluded.has(entry.key))
      .slice(0, 5000)
      .map((entry) => entry.key);
    return peer
      .call("changes.draftMessage", { ...target, paths }, { signal, timeoutMs: 70_000 })
      .then((result) => result.message);
  };
  const sendText = async (text: string, sentKey: TranslationKey) => {
    if (status?.root.kind === "worktree") return false;
    const accepted = await call(() => send(text));
    if (accepted) flash(sentKey);
    else if (accepted === false) flash("changes.sendBlocked", true);
    return !!accepted;
  };
  /** Comments and open findings go out together; findings alone are "Fix all". */
  const sendComments = async () => {
    const findings = reviews.open;
    const body = comments.length
      ? [
          commentsMessage(t, comments),
          ...(findings.length ? ["", findingsList(t, findings, "changes.review.fixIntro")] : []),
        ].join("\n")
      : findingsList(t, findings, "changes.review.fixAllMessage");
    const text = findings.length ? [t("agentReview.legacyFix"), body].join("\n\n") : body;
    const sentKey = comments.length ? "changes.comment.sent" : "changes.review.fixSent";
    if (await sendText(text, sentKey)) {
      updateComments(() => []);
      setEditing(undefined);
      void reviews.update(
        findings.map((item) => item.id),
        "sent",
      );
    }
  };
  /**
   * In a direct chat the user picks who reviews. The pick is handed to the brain first and
   * used once by the review the message below starts; "remember" also makes it the default.
   */
  const review = async (choice?: { botId: string; remember: boolean }) => {
    const list = reviewers.list;
    const reviewerId = choice?.botId ?? list?.reviewerId;
    const reviewer = list?.bots.find((bot) => bot.id === reviewerId);
    if (list && reviewerId) {
      const ready = await call(async () => {
        await peer.call(
          "changes.reviewerSet",
          {
            ...target,
            botId: reviewerId,
            review: { scope: scope === "turn" ? "turn" : "uncommitted" },
          },
          { timeoutMs: 10_000 },
        );
        if (choice?.remember && reviewerId !== list.defaultId)
          await peer.call(
            "bots.update",
            { botId: list.authorId, reviewBotId: reviewerId },
            { timeoutMs: 10_000 },
          );
        return true;
      });
      if (!ready) return flash("changes.reviewer.failed", true);
    }
    if (
      await sendText(
        [
          t("agentReview.request"),
          ...(reviewer && reviewer.id !== list?.authorId
            ? [t("changes.reviewer.request", { name: reviewer.name })]
            : []),
          reviewMessage(t, scope === "turn" ? "turn" : "uncommitted", files),
        ].join("\n\n"),
        "agentReview.requested",
      )
    ) {
      setReviewAsked(true);
      // Only an actual review_start child produces version-bound independent review evidence.
    }
  };
  /** The built-in code reviewer, created on demand and made the default at once. */
  const reviewWithBuiltin = async () => {
    const created = await call(() =>
      peer.call("builtin.createBot", { roleId: "code-reviewer" }, { timeoutMs: 60_000 }),
    );
    if (!created) return flash("changes.reviewer.failed", true);
    await reviewers.reload();
    await review({ botId: created.bot.id, remember: true });
  };
  const findingActions = {
    ignore: (finding: ReviewFinding) => void reviews.update([finding.id], "dismissed"),
    fix: async (finding: ReviewFinding) => {
      if (
        await sendText(
          [t("agentReview.legacyFix"), fixOneMessage(t, finding)].join("\n\n"),
          "changes.review.fixSent",
        )
      )
        void reviews.update([finding.id], "sent");
    },
  };
  const jumpToFinding = () => {
    if (!reviews.firstFile) return;
    open(reviews.firstFile);
    setRevealFinding((value) => value + 1);
  };

  const listActions = useMemo<FileListActions>(
    () => ({
      open,
      toggleFolder: (dir, value) => setFolders((current) => new Map(current).set(dir, value)),
      showAll: (dir) => setShowAll((current) => new Set(current).add(dir)),
      toggleGenerated: () => setGeneratedOpen((value) => !value),
      toggleIncluded: (key, included) =>
        setExcluded((current) => {
          const next = new Set(current);
          if (included) next.delete(key);
          else next.add(key);
          return next;
        }),
      discard: (entry) => setConfirm({ key: entry.key, display: entry.display, tag: entry.tag }),
    }),
    [open],
  );
  const selectRoot = (id: string | undefined, next: ChangesScopeName) => {
    setRootId(id);
    setScope(next);
    setNotice(undefined);
    setCommitted(undefined);
    setExcluded(new Set());
  };
  const lineComment = (side: "new" | "old", line: number, extend: boolean) => {
    if (!file) return;
    setEditing((current) =>
      extend && current && current.fileKey === file.key && current.side === side
        ? { ...current, from: Math.min(current.from, line), to: Math.max(current.to, line) }
        : { fileKey: file.key, display: file.display, side, from: line, to: line },
    );
  };
  const saveComment = (text: string) => {
    const anchor = editing;
    if (!anchor || !text.trim()) return;
    updateComments((current) => [
      ...current,
      { ...anchor, id: crypto.randomUUID(), text: text.trim() },
    ]);
    setEditing(undefined);
  };
  const discardHunk = (hunk: DiffHunk) => {
    if (file)
      setConfirm({
        key: file.key,
        display: file.display,
        tag: file.tag,
        hunk: { index: hunk.index, digest: hunk.digest },
      });
  };

  const discardOffice = (item: string, digest: string) => {
    if (file)
      setConfirm({
        key: file.key,
        display: file.display,
        tag: file.tag,
        office: { item, digest },
      });
  };

  return {
    t,
    peer,
    target,
    source,
    state,
    status,
    git,
    repo,
    rootId,
    setRootId: (id: string | undefined) => selectRoot(id, "uncommitted"),
    /** From a read-only folder's empty "this turn" back to the folder the turn did change. */
    viewPrimaryTurn: () => selectRoot(undefined, "turn"),
    scope,
    setScope,
    turn,
    readonlyRoot,
    /** "This turn" count for the scope bar: the turn's total, or 0 in a read-only folder. */
    turnCount: readonlyRoot ? 0 : turn.data?.total,
    commit,
    setCommit: (value: ChangeCommit | undefined) => {
      setCommit(value);
      setSelected(undefined);
      setView("list");
    },
    commitFiles,
    files,
    rows,
    order,
    matched,
    index,
    file,
    selected,
    setSelected,
    view,
    setView,
    query,
    setQuery,
    tree,
    setTree,
    excluded,
    editable,
    commentable,
    comments,
    commentCounts,
    updateComments,
    editing,
    setEditing,
    lineComment,
    saveComment,
    discardHunk,
    discardOffice,
    /** The folder can be written now; a past turn or commit is read-only in this panel. */
    writable: status?.root.kind !== "worktree" && git?.state === "repo" && git.writable && !running,
    staleAt,
    confirm,
    setConfirm,
    discard,
    busy,
    notice,
    setNotice,
    committed,
    setCommitted,
    historyRevision,
    diff,
    step,
    listActions,
    commitNow,
    draft,
    sendText,
    sendComments,
    review,
    reviewWithBuiltin,
    reviewers,
    reviewing: reviewAsked,
    reviews,
    findingActions,
    jumpToFinding,
    revealFinding,
    expansion,
    loadImage,
    botName,
    runningName: options.runningName ?? botName,
    running,
  };
}
export type ChangesPaneModel = ReturnType<typeof useChangesPane>;
