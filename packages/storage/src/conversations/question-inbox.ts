import { UserQuestionPauseSchema } from "@pibot/protocol-base";
import { MessagesRepo } from "../workspace/repositories.ts";
import type { InboxSource } from "./inbox.ts";
import { routineQuestionOriginSql } from "./question-origin.ts";

// Source cards only: forwarded group mirrors and program plan decisions have their own owner.
const pendingQuestions = `SELECT m.id,m.created_at AS at,m.id AS messageId FROM messages m
JOIN conversations c ON c.id=m.conversation_id
JOIN runs r ON r.id=m.run_id AND r.message_id=m.id AND r.bot_id=m.bot_id AND r.conversation_id=c.id
JOIN bots b ON b.id=m.bot_id AND b.archived_at IS NULL
WHERE c.archived_at IS NULL AND c.internal_task_id IS NULL
AND (c.routine_id IS NULL OR (${routineQuestionOriginSql}))
AND m.role='assistant' AND m.status='done' AND r.status='done'
AND r.kind IN ('chat','wake','group_task')
AND json_extract(m.usage,'$.executionPause.reason')='needs_user'
AND json_extract(m.usage,'$.executionPause.answer') IS NULL
AND json_extract(m.usage,'$.executionPause.sourceMessageId') IS NULL
AND COALESCE(json_extract(m.usage,'$.executionPause.fixedOptions'),0)=0
AND (c.kind<>'dm' OR c.bot_id=m.bot_id)
AND (c.group_id IS NULL OR EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id=c.group_id AND gm.bot_id=m.bot_id AND gm.left_at IS NULL))
AND NOT EXISTS (SELECT 1 FROM messages newer WHERE newer.conversation_id=c.id AND newer.role='user' AND newer.rowid>m.rowid)`;

export const questionInboxSource: InboxSource = {
  select: `SELECT 'user_question',id,at,messageId FROM (${pendingQuestions})`,
  counts: { user_question: `SELECT COUNT(*) FROM (${pendingQuestions})` },
  item(row, _context, db) {
    const message = new MessagesRepo(db).get(row.id);
    const usage = message?.usage;
    const pause = UserQuestionPauseSchema.parse(
      usage && typeof usage === "object" && !Array.isArray(usage)
        ? usage.executionPause
        : undefined,
    );
    return { message, pause };
  },
};
