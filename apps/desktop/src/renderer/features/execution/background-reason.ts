import type { TranslationKey } from "@pibot/i18n";
import type { BackgroundCommand } from "@pibot/protocol";

/**
 * An automatically stopped command keeps its reason (exposed listener, restart, time
 * limit, user). The chat line and the task panel share this key so both name the same cause;
 * only a stop without a recorded reason falls back to the plain "stopped" label.
 */
export function stoppedReasonKey(
  row: Pick<BackgroundCommand, "status" | "stopReason">,
): TranslationKey | undefined {
  return row.status === "stopped" && row.stopReason
    ? `background.reason.${row.stopReason}`
    : undefined;
}
