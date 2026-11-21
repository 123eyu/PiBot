import type { createTranslator } from "@pibot/i18n";
import { type Message, replyCitationCheck } from "@pibot/protocol";

export function replyCitationText(
  message: Pick<Message, "role" | "usage">,
  t: ReturnType<typeof createTranslator>,
): string[] {
  const check = message.role === "assistant" ? replyCitationCheck(message) : undefined;
  return check
    ? [
        ...(check.unread ? [t("chat.citationsUnread", { count: check.unread })] : []),
        ...(check.incomplete ? [t("chat.citationsIncomplete")] : []),
        t("chat.citationsScope"),
      ]
    : [];
}
