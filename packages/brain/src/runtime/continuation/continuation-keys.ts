export const TASK_CONTINUATION_KIND = "task-summary";
export const TASK_CONTINUATION_PREFIX = `${TASK_CONTINUATION_KIND}:`;

/**
 * One place for automatic-continuation dedupe keys: `${kind}:${rootRunId}:${triggerId}[:attempt]`.
 * The root keeps one run chain's keys apart, `triggerId` names what asked for the continuation,
 * and `attempt` is only used when a previous attempt's run was rolled back and may be retried.
 * Routine "run now" is deliberately not deduped (a user tapping twice means two runs) and does not
 * use this helper.
 */
export function continuationKey(
  kind: string,
  rootRunId: string,
  triggerId: string,
  attempt = 0,
): string {
  const key = `${kind}:${rootRunId}:${triggerId}`;
  return attempt === 0 ? key : `${key}:${attempt}`;
}
