import { toRoutineRunView } from "@pibot/protocol";
import type { InboxSource } from "@pibot/storage";
import { RoutineProposalsRepo, RoutineRunsRepo, RoutinesRepo } from "../store/index.ts";

const MISSED =
  "status='missed' OR (status='skipped_missed' AND error_code='missed_too_old' AND inbox_dismissed_at IS NULL)";
const AWAY = "paused_reason='away_7d' AND deleted_at IS NULL";

/** What routines put in the inbox: missed runs, open proposals, trigger errors, away pauses. */
export const routineInboxSource: InboxSource = {
  select: `SELECT 'routine_missed',id,created_at,NULL FROM routine_runs WHERE ${MISSED}
      UNION ALL SELECT 'routine_proposal',id,created_at,message_id FROM routine_proposals WHERE status='open'
      UNION ALL SELECT 'routine_trigger_error',id,updated_at,NULL FROM routines WHERE paused_reason='trigger_error' AND deleted_at IS NULL
      UNION ALL SELECT 'routines_paused_away',MIN(id),MAX(updated_at),NULL FROM routines WHERE ${AWAY} HAVING COUNT(*)>0`,
  counts: {
    routine_missed: `SELECT COUNT(*) FROM routine_runs WHERE ${MISSED}`,
    routine_proposal: "SELECT COUNT(*) FROM routine_proposals WHERE status='open'",
    routine_trigger_error:
      "SELECT COUNT(*) FROM routines WHERE paused_reason='trigger_error' AND deleted_at IS NULL",
    routines_paused_away: `SELECT CASE WHEN COUNT(*)>0 THEN 1 ELSE 0 END FROM routines WHERE ${AWAY}`,
  },
  item(row, context, db) {
    if (row.kind === "routine_missed")
      return { run: toRoutineRunView(new RoutineRunsRepo(db).require(row.id)) };
    if (row.kind === "routine_proposal")
      return {
        proposal: new RoutineProposalsRepo(db).get(row.id),
        conversationId: context.conversation?.conversationId ?? null,
      };
    if (row.kind === "routine_trigger_error") return { routine: new RoutinesRepo(db).get(row.id) };
    return {
      at: row.at,
      count: db.prepare(`SELECT COUNT(*) AS n FROM routines WHERE ${AWAY}`).get()?.n,
    };
  },
};
