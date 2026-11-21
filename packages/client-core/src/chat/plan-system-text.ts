import type { createTranslator } from "@pibot/i18n";
import type { Message } from "@pibot/protocol";

/** Legacy program acknowledgements have no run; never translate a model's quoted prose. */
export function planSystemText(
  message: Pick<Message, "content"> & Partial<Pick<Message, "role" | "runId">>,
  t: ReturnType<typeof createTranslator>,
) {
  if (message.role !== "assistant" || message.runId !== null) return message.content;
  const registered =
    /^已登记计划「([^\r\n]+)」，正在安排步骤。 \/ Plan “\1” registered; scheduling steps\.$/u.exec(
      message.content,
    );
  if (registered) return t("group.plan.registered", { name: registered[1] ?? "" });
  return message.content;
}
