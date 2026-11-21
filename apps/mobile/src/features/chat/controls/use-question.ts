import { type Message, UserQuestionPauseSchema } from "@pibot/protocol";
import { useState } from "react";
import { useLinkState, useRuntime } from "../../../runtime/context.tsx";
import { useAction } from "../../../runtime/use-action.ts";
import { answerQuestion } from "./calls.ts";
import { type ChatScope, scopeKey } from "./scope.ts";

/** The question card a finished reply may carry (the same `executionPause` the desktop reads). */
export function messageQuestion(message: Message) {
  const usage = message.usage;
  if (message.role !== "assistant" || !usage || typeof usage !== "object" || Array.isArray(usage))
    return undefined;
  const pause = UserQuestionPauseSchema.safeParse(usage.executionPause);
  return pause.success ? pause.data : undefined;
}
/** Choice-card answers; the brain checks the card still belongs to this conversation. */
export function useQuestion(scope: ChatScope | undefined) {
  const runtime = useRuntime(),
    mobile = useLinkState();
  const action = useAction(`${mobile.selectedId}:question:${scopeKey(scope)}`, mobile.peer);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return {
    action,
    answers,
    answer: (message: Message, optionId: string, label: string) =>
      action.run(async (signal) => {
        await answerQuestion(runtime, message.id, optionId, signal);
        signal.throwIfAborted();
        setAnswers((rows) => ({ ...rows, [message.id]: label }));
        return true;
      }),
  };
}
