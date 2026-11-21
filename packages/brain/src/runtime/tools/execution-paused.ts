import { ExecError } from "@pibot/execution";

/**
 * While a background cleanup is unconfirmed the command runtime refuses every new command, so the
 * text has to say what happens next (retry, then restart) instead of "tool approval failed": that
 * wording hid the real cause for 5.5 hours and 1,380 attempts.
 */
export const EXECUTION_PAUSED =
  "后台命令没能清理干净，为安全起见暂停新命令；正在自动重试清理，通常 30 秒内恢复，重启 Pi Bot 也能恢复 / A background command could not be cleaned up, so new commands are paused for safety. Cleanup is retried automatically (usually within 30 seconds); restarting Pi Bot also restores it.";

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
