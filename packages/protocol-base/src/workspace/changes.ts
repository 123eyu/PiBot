import { z } from "zod";
import { SidebarKeySchema } from "../app/sidebar.ts";
import { ThumbnailContentSchema } from "../chat/attachments.ts";
import { IdSchema } from "../core/ids.ts";
import { CheckpointCaptureSchema } from "./checkpoint-capture.ts";

/** Changes sidebar: Git status, diffs, history, discard/commit and "this turn". */
const count = z.number().int().nonnegative().safe();
const text = z.string().min(1);
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\0\r\n]/.test(value));
export const GitOidSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
/** Conservative portable subset; full Git option/revision syntax is never accepted. */
export const GitRefNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (name) =>
      /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(name) &&
      name !== "HEAD" &&
      !name.startsWith("pibot/") &&
      !name.includes("..") &&
      !name.includes("//") &&
      name
        .split("/")
        .every(
          (part) =>
            !!part && !part.startsWith(".") && !part.endsWith(".") && !part.endsWith(".lock"),
        ),
  );
const rootId = z.union([z.literal("home"), IdSchema]);
const targetFields = {
  conversationKey: SidebarKeySchema,
  /** A DM topic selects that topic's working folder; omitted means the Bot's current folder. */
  topicId: IdSchema.optional(),
  /** Defaults to the primary folder; associated read-only folders can be viewed only. */
  rootId: rootId.optional(),
};
const validTarget = (p: { conversationKey: string; topicId?: string }) =>
  !p.topicId || p.conversationKey.startsWith("dm:");
export const ChangesTargetSchema = z.strictObject(targetFields).refine(validTarget);
export type ChangesTarget = z.infer<typeof ChangesTargetSchema>;

export const ChangesErrorCodeSchema = z.enum([
  "changes_remote_unavailable",
  "changes_remote_unsupported",
  "changes_remote_no_upstream",
  "changes_remote_dirty",
  "changes_remote_auth",
  "changes_remote_rejected",
  "changes_remote_diverged",
  "changes_remote_network",
  "changes_remote_policy",
  "changes_ref_unavailable",
  "changes_ref_dirty",
  "changes_ref_exists",
  "changes_not_repo",
  "changes_readonly_root",
  "changes_operation_in_progress",
  "changes_busy",
  "changes_stale",
  "changes_author_missing",
  "changes_isolation_unavailable",
  "changes_git_unavailable",
  "changes_write_failed",
  "changes_hunk_unsupported",
  /** No capability can compare or rewrite this document's structure. */
  "changes_office_unsupported",
  /** This object has no counterpart on the older side that can be spliced back. */
  "changes_office_unrestorable",
  "changes_draft_unavailable",
  "changes_draft_invalid",
  /** The repository root is above the folder; writing .git would cross the workplace boundary. */
  "changes_repo_above_folder",
]);
export type ChangesErrorCode = z.infer<typeof ChangesErrorCodeSchema>;

/** Generated drafts have a fixed format; user-written commit messages stay unrestricted. */
export const GeneratedCommitMessageSchema = z
  .string()
  .min(1)
  .max(4000)
  .refine((message) => {
    const title = message.split("\n", 1)[0] ?? "";
    return (
      Array.from(title).length <= 72 &&
      title === title.trim() &&
      /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^()\r\n]+\))?!?: \S[^\r\n]*$/.test(
        title,
      )
    );
  });

export const ChangeRootSchema = z.strictObject({
  id: rootId,
  name: text,
  path: text,
  role: z.enum(["primary", "readonly", "writable"]),
  kind: z.literal("worktree").optional(),
});
export const ChangesGitSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("repo"),
    /** null when HEAD is detached. */
    branch: z.string().nullable(),
    /** null before the first commit. */
    head: GitOidSchema.nullable(),
    operation: z.enum(["merge", "rebase", "cherry-pick", "revert"]).nullable(),
    writable: z.boolean(),
    readOnlyReason: z
      .enum([
        "readonly_root",
        "operation_in_progress",
        "isolation_unavailable",
        "repo_layout",
        "repo_above_folder",
      ])
      .nullable(),
    /**
     * The folder's "/" separated location inside a repository whose root is above it
     * (e.g. a dotfiles repository in the home directory). Status, diffs and history then cover
     * only this folder, every path is relative to the folder, and writes are refused.
     */
    subdirectory: path.nullable(),
    /** Commits never run the repository's Git hooks; the commit box says so. */
    hooksSkipped: z.literal(true),
    /** False on Windows, where the user's discard / commit runs without a sandbox. */
    writesIsolated: z.boolean(),
    /**
     * Commits ahead of / behind the branch's upstream as this computer last saw it
     * (local refs only, never fetched). Null without an upstream; omitted by older brains.
     */
    upstream: z.strictObject({ ahead: count, behind: count }).nullable().optional(),
  }),
  z.strictObject({
    state: z.literal("none"),
    reason: z.enum(["not_repo", "git_unavailable"]),
  }),
]);
export const ChangeStatusSchema = z.enum([
  "modified",
  "added",
  "deleted",
  "untracked",
  "typechange",
  "conflicted",
]);
export const ChangeFileSchema = z.strictObject({
  /** Folder-relative, "/" separated; the repository-relative path unless git.subdirectory is set. */
  path,
  status: ChangeStatusSchema,
  added: count.nullable(),
  removed: count.nullable(),
  binary: z.boolean(),
  /** Lock files, build output and dependencies are grouped last. */
  generated: z.boolean(),
});
export const ChangesTotalsSchema = z.strictObject({
  files: count,
  added: count,
  removed: count,
});
export const GitIdentitySchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().min(1).max(320),
});
export const ChangesStatusSchema = z.strictObject({
  root: ChangeRootSchema,
  // Up to 201 configured execution roots plus 50 bounded SCM-only registry choices.
  roots: z.array(ChangeRootSchema).max(251),
  git: ChangesGitSchema,
  /** Resolved by Git's own config order in this repository; null asks the user to fill it. */
  author: GitIdentitySchema.nullable(),
  files: z.array(ChangeFileSchema).max(2000),
  total: count,
  nextCursor: path.nullable(),
  /** Git printed more status than the reader accepts; the list is empty instead of partial. */
  overflow: z.boolean(),
  totals: ChangesTotalsSchema.nullable(),
  /** Line counts are still being computed; a changes.changed event with reason "stats" follows. */
  statsPending: z.boolean(),
});
export const DiffHunkSchema = z.strictObject({
  index: count,
  header: text,
  oldStart: count,
  oldLines: count,
  newStart: count,
  newLines: count,
  /** Raw unified-diff lines, each starting with " ", "+", "-" or "\\". */
  lines: z.array(z.string()).max(100_000),
  /** Required by changes.discard so a stale hunk is never reverted. */
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
/**
 * One changed object of a Word / Excel / PowerPoint file. The panel lists these instead of
 * "binary file", and each one can be reverted on its own through changes.discardOffice.
 */
export const OfficeChangeKindSchema = z.enum([
  "slide",
  "shape",
  "paragraph",
  "table",
  "comment",
  "revision",
  "sheet",
  "cell_range",
  "chart",
  "pivot",
]);
export const OfficeChangeItemSchema = z.strictObject({
  /** Stable for one before/after pair; discardOffice sends it back and the engine resolves it again. */
  id: z
    .string()
    .min(1)
    .max(120)
    .refine((value) => !/[\0\r\n]/.test(value)),
  kind: OfficeChangeKindSchema,
  /** 1-based page, slide or sheet number; null when the object has no page. */
  page: count.nullable(),
  /** Sheet name, slide title or shape name when the format has one — document content, not UI copy. */
  name: z
    .string()
    .max(200)
    .nullable()
    .refine((value) => value === null || !/[\0\r\n]/.test(value)),
  /** Excel cell range ("A1:C4"), null for the other formats. */
  area: z
    .string()
    .max(60)
    .nullable()
    .refine((value) => value === null || !/[\0\r\n]/.test(value)),
  /** One line of the object's text on each side, truncated by the engine. */
  before: z.string().nullable(),
  after: z.string().nullable(),
  /** False when the engine can describe the change but not restore that object. */
  retractable: z.boolean(),
});
export const OfficeChangesSchema = z.strictObject({
  items: z.array(OfficeChangeItemSchema).max(200),
  /** Changes the engine found beyond the cap; the panel says so instead of silently hiding them. */
  omitted: count,
  /** sha256 of the newer side: discardOffice refuses once the file no longer matches it. */
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
export const ChangesDiffSchema = z.strictObject({
  path,
  binary: z.boolean(),
  /** Over the single-file limit: only counts are given; the UI shows them without the text. */
  tooLarge: z.boolean(),
  unavailable: z.enum(["command", "snapshot_missing"]).nullable(),
  added: count.nullable(),
  removed: count.nullable(),
  hunks: z.array(DiffHunkSchema).max(10_000),
  /** Omitted by older brains and for files the office engine cannot compare (still "binary"). */
  office: OfficeChangesSchema.optional(),
});
export const TurnFileSchema = z.strictObject({
  path,
  /** Relative to the run's primary folder when inside it. */
  displayPath: path,
  kind: z.enum(["add", "modify", "delete", "command"]),
  added: count.nullable(),
  removed: count.nullable(),
  binary: z.boolean(),
  diffAvailable: z.boolean(),
  /**
   * Can open in the file preview pane (preview.read with { runId, path }): not deleted, inside
   * its recorded folder, a previewable format. Whether it still exists is checked on read.
   */
  previewable: z.boolean().optional(),
});
export const ChangesTurnSchema = z.strictObject({
  /** Absent for older runs or turns without file-tool writes. */
  checkpoint: CheckpointCaptureSchema.optional(),
  runId: IdSchema.nullable(),
  botId: IdSchema.nullable(),
  root: z.string().nullable(),
  files: z.array(TurnFileSchema).max(500),
  total: count,
  truncated: z.boolean(),
  /** Successfully restored historical files are not part of the remaining turn list. */
  restoredCount: count.optional(),
});
export const ChangeCommitSchema = z.strictObject({
  oid: GitOidSchema,
  author: z.string(),
  email: z.string(),
  time: z.iso.datetime(),
  subject: z.string(),
  /** Files the commit changed (first parent for merges); null when not counted. */
  files: count.nullable().optional(),
});

/** Unchanged lines of the file's newer side, for expanding the gaps between hunks. */
export const ChangesLinesSchema = z.strictObject({
  /** The requested lines (raw, without the newline); fewer near the end of the file. */
  lines: z.array(z.string()).max(2000),
  /** Line count of that side; null when it is binary, missing or over the read limit. */
  total: count.nullable(),
});
/** One side of an image diff as a small thumbnail; the image itself never travels. */
export const ChangesImageSideSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("ok"),
    mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/),
    bytes: count,
    width: count.nullable(),
    height: count.nullable(),
    thumbnail: ThumbnailContentSchema,
  }),
  /** The file does not exist on this side (added / deleted). */
  z.strictObject({ state: z.literal("missing") }),
  z.strictObject({ state: z.literal("too_large"), bytes: count }),
  /** Not a recognised image format, or no thumbnail could be made on this computer. */
  z.strictObject({ state: z.literal("unsupported") }),
]);
export const ReviewSeveritySchema = z.enum(["security", "bug", "suggestion"]);
export const ReviewFindingStateSchema = z.enum(["open", "dismissed", "sent"]);
/** One finding a Bot reported with review_finding during a review run. */
export const ReviewFindingSchema = z.strictObject({
  id: IdSchema,
  runId: IdSchema,
  /** Folder-relative, "/" separated. */
  path,
  /** Newer-side line; null means the whole file. */
  line: count.positive().nullable(),
  endLine: count.positive().nullable(),
  severity: ReviewSeveritySchema,
  message: z.string().min(1).max(2000),
  state: ReviewFindingStateSchema,
  createdAt: z.iso.datetime(),
});
export type ChangeFile = z.infer<typeof ChangeFileSchema>;
export type ChangesStatus = z.infer<typeof ChangesStatusSchema>;
export type ChangesDiff = z.infer<typeof ChangesDiffSchema>;
export type OfficeChangeKind = z.infer<typeof OfficeChangeKindSchema>;
export type OfficeChangeItem = z.infer<typeof OfficeChangeItemSchema>;
export type OfficeChanges = z.infer<typeof OfficeChangesSchema>;
export type ChangesTurn = z.infer<typeof ChangesTurnSchema>;
export type ChangeCommit = z.infer<typeof ChangeCommitSchema>;
export type DiffHunk = z.infer<typeof DiffHunkSchema>;
export type ChangesImageSide = z.infer<typeof ChangesImageSideSchema>;
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewSeverity = z.infer<typeof ReviewSeveritySchema>;
export type GitIdentity = z.infer<typeof GitIdentitySchema>;
