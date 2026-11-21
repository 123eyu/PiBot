import type { DatabaseSync } from "node:sqlite";
import {
  BACKGROUND_FAILURE_THRESHOLD,
  BaseInboxItemSchema,
  InboxCountsSchema,
  type InboxItemEnvelope,
  type InboxPage,
  InboxPageSchema,
} from "@pibot/protocol-base";
import type { z } from "zod";
import { MemoriesRepo } from "../bots/memory.ts";
import { ApprovalsRepo } from "../permissions/approvals.ts";
import { BackgroundTaskHealthRepo, backgroundHealthRowId } from "../runs/background-health.ts";
import { ChatNoticesRepo } from "./chat-notices.ts";
import { inboxOrigin } from "./inbox-origin.ts";
import { PersonalTodosRepo } from "./personal-todos.ts";
import { planActionInboxSource, planInboxSource } from "./plan-inbox.ts";
import { questionInboxSource } from "./question-inbox.ts";

// Open "come help for a moment" cards (closed ones stay in the chat as a result line).
const OPEN_HANDOFF = "kind='computer_handoff' AND json_extract(detail,'$.status')='pending'";

/** One inbox row before it becomes an item: what the UNION of all sources selects. */
export interface InboxRow {
  kind: string;
  id: string;
  at: string;
  messageId: string | null;
}
/** Facts the inbox already resolved for a row (its cursor, and its message's topic if any). */
export interface InboxRowContext {
  cursor: string;
  conversation?: { conversationId: string; kind: string };
}
/**
 * A kind of item in the inbox (capabilities contribute theirs, e.g. routines' missed runs).
 * The inbox unions every source's `select`, pages the result by time with one keyset cursor, and
 * asks the owning source to build each item. Sources are SQL without parameters.
 */
export interface InboxSource {
  /** `SELECT <kind>,id,at,messageId FROM …`; each kind it yields has an entry in `counts`. */
  readonly select: string;
  /** One scalar subquery per kind, for the badge counts. */
  readonly counts: Readonly<Record<string, string>>;
  /** The item fields for one of its rows; `kind` and `cursor` are added by the inbox. */
  item(row: InboxRow, context: InboxRowContext, db: DatabaseSync): Record<string, unknown>;
}

/** The kernel's own inbox kinds; approvals are handled inline (their query takes a filter). */
const kernelSources: InboxSource[] = [
  questionInboxSource,
  planInboxSource,
  planActionInboxSource,
  {
    select: "SELECT 'personal_todo',id,created_at,NULL FROM personal_todos WHERE status='open'",
    counts: { personal_todo: "SELECT COUNT(*) FROM personal_todos WHERE status='open'" },
    item: (row, _context, db) => ({ todo: new PersonalTodosRepo(db).get(row.id) }),
  },
  {
    select:
      "SELECT 'memory',id,created_at,message_id FROM scoped_memory_proposals WHERE status='pending' AND scope<>'group' AND NOT EXISTS (SELECT 1 FROM memory_scope_moves m WHERE m.target_proposal_id=scoped_memory_proposals.id)",
    counts: {
      memory:
        "SELECT COUNT(*) FROM scoped_memory_proposals WHERE status='pending' AND scope<>'group' AND NOT EXISTS (SELECT 1 FROM memory_scope_moves m WHERE m.target_proposal_id=scoped_memory_proposals.id)",
    },
    item: (row, context, db) => ({
      proposal: new MemoriesRepo(db, (text) => text).proposal(row.id),
      conversationId: context.conversation?.conversationId ?? null,
      conversationKind: context.conversation?.kind ?? null,
    }),
  },
  {
    select:
      "SELECT 'provider',id,updated_at,NULL FROM providers WHERE json_extract(config,'$.authState')='reauthRequired'",
    counts: {
      provider:
        "SELECT COUNT(*) FROM providers WHERE json_extract(config,'$.authState')='reauthRequired'",
    },
    item: (row) => ({ providerId: row.id, state: "reauthRequired" }),
  },
  {
    select: `SELECT 'computer_handoff',id,created_at,NULL FROM chat_notices WHERE ${OPEN_HANDOFF}`,
    counts: { computer_handoff: `SELECT COUNT(*) FROM chat_notices WHERE ${OPEN_HANDOFF}` },
    item: (row, _context, db) => {
      const notice = new ChatNoticesRepo(db).get(row.id);
      const place = notice
        ? db.prepare("SELECT kind,title FROM conversations WHERE id=?").get(notice.conversationId)
        : undefined;
      return {
        notice,
        conversationKind: place?.kind,
        conversationTitle: typeof place?.title === "string" && place.title ? place.title : null,
      };
    },
  },
  {
    // Use the same threshold as the repo so list, count and row resolution agree.
    select: `SELECT 'background_task',${backgroundHealthRowId},last_failed_at,NULL FROM background_task_health WHERE streak>=${BACKGROUND_FAILURE_THRESHOLD}`,
    counts: {
      background_task: `SELECT COUNT(*) FROM background_task_health WHERE streak>=${BACKGROUND_FAILURE_THRESHOLD}`,
    },
    item: (row, _context, db) => ({
      health: new BackgroundTaskHealthRepo(db).get(row.id),
    }),
  },
];

export class InboxRepo {
  /** `sources` is read on every query, so capabilities may register after construction. */
  constructor(
    private readonly db: DatabaseSync,
    private readonly sources: readonly InboxSource[] = [],
    private readonly itemSchema: z.ZodType<InboxItemEnvelope> = BaseInboxItemSchema,
  ) {}
  private all() {
    return [...kernelSources, ...this.sources];
  }
  list(page: InboxPage = {}): InboxItemEnvelope[] {
    const {
      before,
      limit = 50,
      kind: filter,
      draftsOnly,
      questionsOnly,
    } = InboxPageSchema.parse(page);
    // Encode time in the cursor so resolving/removing its item cannot truncate the next page.
    const parts = before?.split("|");
    const at = parts?.[0] ?? null,
      kind = parts?.[1] ?? null,
      id = parts?.[2] ? decodeURIComponent(parts[2]) : null;
    const sources = this.all();
    const owner = new Map<string, InboxSource>();
    for (const source of sources) for (const k of Object.keys(source.counts)) owner.set(k, source);
    const union = [
      "SELECT CASE WHEN source='chat' THEN 'approval' ELSE 'routine_approval' END AS kind,id,created_at AS at,message_id AS messageId FROM approvals WHERE status='pending' AND (? = 0 OR EXISTS(SELECT 1 FROM send_drafts d WHERE d.approval_id=approvals.id AND d.status='pending'))",
      ...sources.map((source) => source.select),
    ].join("\n      UNION ALL ");
    const rows = this.db
      .prepare(
        `SELECT * FROM (${union}) WHERE (? = 0 OR kind IN ('approval','routine_approval')) AND (? = 0 OR kind IN ('user_question','routine_proposal')) AND (? IS NULL OR kind=?) AND (? IS NULL OR at<? OR (at=? AND (kind<? OR (kind=? AND id<?)))) ORDER BY at DESC,kind DESC,id DESC LIMIT ?`,
      )
      .all(
        Number(draftsOnly ?? false),
        Number(draftsOnly ?? false),
        Number(questionsOnly ?? false),
        filter ?? null,
        filter ?? null,
        before ?? null,
        at,
        at,
        kind,
        kind,
        id,
        limit,
      );
    const approvals = new ApprovalsRepo(this.db);
    return rows.map((r) => {
      const row: InboxRow = {
        kind: String(r.kind),
        id: String(r.id),
        at: String(r.at),
        messageId: r.messageId == null ? null : String(r.messageId),
      };
      const place = row.messageId
        ? this.db
            .prepare(
              "SELECT m.conversation_id,c.kind FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?",
            )
            .get(row.messageId)
        : undefined;
      const context: InboxRowContext = {
        cursor: `${row.at}|${row.kind}|${encodeURIComponent(row.id)}`,
        ...(place
          ? {
              conversation: {
                conversationId: String(place.conversation_id),
                kind: String(place.kind),
              },
            }
          : {}),
      };
      const parse = (value: Record<string, unknown>) =>
        this.itemSchema.parse({
          ...value,
          origin: inboxOrigin(this.db, value, row.messageId),
        });
      if (row.kind === "approval" || row.kind === "routine_approval")
        return parse({
          kind: row.kind,
          cursor: context.cursor,
          approval: approvals.get(row.id),
          conversationId: context.conversation?.conversationId,
          conversationKind: context.conversation?.kind,
        });
      const source = owner.get(row.kind);
      if (!source) throw new Error(`Inbox kind without a source: ${row.kind}`);
      return parse({
        kind: row.kind,
        cursor: context.cursor,
        ...source.item(row, context, this.db),
      });
    });
  }
  counts() {
    const columns = [
      "(SELECT COUNT(*) FROM send_drafts WHERE status='pending') AS draft",
      "(SELECT COUNT(*) FROM approvals WHERE status='pending' AND source='chat') AS approval",
      "(SELECT COUNT(*) FROM approvals WHERE status='pending' AND source<>'chat') AS routine_approval",
      ...this.all().flatMap((source) =>
        Object.entries(source.counts).map(([k, sql]) => `(${sql}) AS ${k}`),
      ),
    ];
    return InboxCountsSchema.parse(this.db.prepare(`SELECT ${columns.join(",\n      ")}`).get());
  }
}
