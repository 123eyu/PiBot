import type { TranslationKey, TranslationVars } from "@pibot/i18n";
import type { ReviewFinding } from "@pibot/workspaces-contract/full";
import type { ListFile } from "../model.ts";

type T = (key: TranslationKey, vars?: TranslationVars) => string;

/** A comment waiting to be sent; `side` says which line numbers `from`/`to` refer to. */
export interface DraftComment {
  id: string;
  fileKey: string;
  display: string;
  side: "new" | "old" | "file";
  from: number;
  to: number;
  text: string;
}
export type CommentAnchor = Omit<DraftComment, "id" | "text">;

export function commentRef(t: T, anchor: Pick<DraftComment, "side" | "from" | "to">) {
  if (anchor.side === "file") return t("changes.comment.refFile");
  if (anchor.side === "old") return t("changes.comment.refOld", { line: anchor.to });
  return anchor.from !== anchor.to
    ? t("changes.comment.refRange", { from: anchor.from, to: anchor.to })
    : t("changes.comment.refLine", { line: anchor.to });
}

/** All comments go out as one ordinary user message, each item with its file and lines. */
export function commentsMessage(t: T, comments: readonly DraftComment[]) {
  // Continuation lines stay indented under their item, so a multi-line comment cannot be read as
  // text outside the list (or as the start of the next numbered item).
  const items = comments.map(
    (comment, index) =>
      `${index + 1}. \`${comment.display}\` ${commentRef(t, comment)}: ${comment.text.trim().replace(/\r?\n/g, "\n   ")}`,
  );
  return [t("changes.comment.messageIntro", { count: comments.length }), "", ...items].join("\n");
}

export function findingRef(t: T, finding: Pick<ReviewFinding, "line" | "endLine">) {
  if (finding.line === null) return t("changes.comment.refFile");
  return commentRef(t, { side: "new", from: finding.line, to: finding.endLine ?? finding.line });
}
const SEVERITY_KEY = {
  security: "changes.review.severity.security",
  bug: "changes.review.severity.bug",
  suggestion: "changes.review.severity.suggestion",
} as const satisfies Record<ReviewFinding["severity"], TranslationKey>;
export const severityLabel = (t: T, severity: ReviewFinding["severity"]) =>
  t(SEVERITY_KEY[severity]);

/** "Fix this": one ordinary user message naming the file, line and what the review said. */
export function fixOneMessage(t: T, finding: ReviewFinding) {
  return t("changes.review.fixOneMessage", {
    path: finding.path,
    ref: findingRef(t, finding),
    severity: severityLabel(t, finding.severity),
    message: finding.message,
  });
}
/** "Fix all", or the same list appended to the comments when both are sent together. */
export function findingsList(t: T, findings: readonly ReviewFinding[], intro: TranslationKey) {
  return [
    t(intro, { count: findings.length }),
    "",
    ...findings.map(
      (item, index) =>
        `${index + 1}. [${severityLabel(t, item.severity)}] \`${item.path}\` ${findingRef(t, item)}: ${item.message}`,
    ),
  ].join("\n");
}

const REVIEW_LISTED = 50;
export function reviewMessage(t: T, scope: "uncommitted" | "turn", files: readonly ListFile[]) {
  const listed = files
    .filter((file) => !file.generated)
    .slice(0, REVIEW_LISTED)
    .map((file) => `- ${file.display}`);
  const rest = files.length - listed.length;
  return [
    t(scope === "turn" ? "changes.review.messageTurn" : "changes.review.messageUncommitted", {
      count: files.length,
    }),
    "",
    ...listed,
    ...(rest > 0 ? [t("changes.review.messageMore", { count: rest })] : []),
    "",
    t("changes.review.messageRules"),
  ].join("\n");
}
