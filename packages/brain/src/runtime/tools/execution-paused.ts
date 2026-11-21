import { ExecError } from "@pibot/execution";

/**
 * While a background cleanup is unconfirmed the command runtime refuses every new command, so the
 * text has to say what happens next (retry, then restart) instead of "tool approval failed": that
 * wording hid the real cause for 5.5 hours and 1,380 attempts.
 */
export const EXECUTION_PAUSED =
  "Pi Bot 没能确认上一条命令已经停下，为安全起见暂停新命令；正在自动检查，确认后自动恢复。侧栏提示里可以「再检查一次」，一直不恢复请重启 Pi Bot / Pi Bot couldn't confirm a previous command stopped, so new commands are paused for safety. It keeps checking and resumes once that's confirmed; the sidebar notice offers \"Check again\", and restarting Pi Bot also clears it.";

/**
 * Identifies the paused runtime from the error alone: the refusal comes from the command layer,
 * not from a person declining, so it must not be shown as a policy or approval failure.
 */
export function executionPaused(error: unknown): string | undefined {
  return error instanceof ExecError &&
    error.code === "command_failed" &&
    error.reason === "cleanup_failed"
    ? EXECUTION_PAUSED
    : undefined;
}
