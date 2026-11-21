import { type ExecutionTopic, nextReply } from "@pibot/client-core";
import { useEffect, useMemo, useState } from "react";
import { useLinkState } from "../../runtime/context.tsx";
import { useApprovals } from "../approvals/approvals-context.tsx";
import { useConversations } from "../conversations/conversations-context.tsx";
import { type ChatScope, scopeKey, scopeTarget } from "./controls/scope.ts";
import { useBrowser } from "./controls/use-browser.ts";
import { useChanges } from "./controls/use-changes.ts";
import { useCompact } from "./controls/use-compact.ts";
import { useGroupPlan, useGroupThreads } from "./controls/use-group-plan.ts";
import { usePlan } from "./controls/use-plan.ts";
import { useQuestion } from "./controls/use-question.ts";
import { useRetry } from "./controls/use-retry.ts";
import { useRunInfo } from "./controls/use-run-info.ts";
import { useSendMode } from "./controls/use-send-mode.ts";
import { useTopics } from "./controls/use-topics.ts";
import { useWorkplace } from "./controls/use-workplace.ts";
import { useYolo } from "./controls/use-yolo.ts";
import { useChat } from "./use-chat.ts";
import { useComposer } from "./use-composer.ts";

/** Everything one chat page shows and controls, composed from the per-control hooks. */
export function useChatPage(kind: ChatScope["kind"], id: string, opened?: string) {
  const mobile = useLinkState(),
    conversations = useConversations(),
    approvals = useApprovals();
  const entry = conversations.find(kind, id);
  const topics = useTopics(kind, id, entry?.topicId, opened);
  const current = topics.current;
  const scope = useMemo<ChatScope | undefined>(
    () => (current ? { kind, id, topicId: current } : undefined),
    [kind, id, current],
  );
  const target = useMemo(() => scope && scopeTarget(scope), [scope]);
  const chat = useChat(target);
  const workplace = useWorkplace(scope),
    plan = usePlan(scope),
    groupPlan = useGroupPlan(scope),
    threads = useGroupThreads(scope),
    changes = useChanges(scope),
    yolo = useYolo(scope),
    mode = useSendMode(scope),
    retry = useRetry(scope),
    question = useQuestion(scope),
    compact = useCompact(scope),
    runInfo = useRunInfo(scope, chat.messages),
    browser = useBrowser(kind, id);
  const members = useMemo(
    () =>
      (kind === "group" ? (entry?.memberIds ?? []) : []).flatMap((botId) => {
        const bot = conversations.bots.get(botId);
        return bot ? [bot] : [];
      }),
    [kind, entry?.memberIds, conversations.bots],
  );
  const composer = useComposer(scope, chat.runId, mode.busyMode, members);
  const [stopNotice, setStopNotice] = useState(false);
  const [dismissed, setDismissed] = useState<string>();
  const key = scopeKey(scope);
  // biome-ignore lint/correctness/useExhaustiveDependencies: page-local notices belong to one topic.
  useEffect(() => {
    setStopNotice(false);
  }, [key]);
  const online = mobile.status === "online",
    connecting = mobile.status === "connecting",
    // A live link that dropped and is coming back (not a first connect).
    reconnecting = connecting && !!mobile.reconnecting;
  // A group's cards also come from its open task threads, where members' runs ask (the shared
  // approvals state, so answering here or on the Approvals page clears both at once).
  const pending = approvals.items.filter(
    (a) =>
      !!scope &&
      !!a.conversationId &&
      (a.conversationId === scope.topicId || threads.has(a.conversationId)),
  );
  const executionTopics: ExecutionTopic[] =
    kind === "bot" && entry
      ? [
          {
            botId: id,
            name: entry.name,
            settings: mode.value,
            plan: plan.value,
            tasks: [],
            next: null,
            loading: false,
            error: false,
          },
        ]
      : [];
  const suggestion = nextReply(scope?.topicId, chat.messages, executionTopics, []);
  const showSuggestion =
    !!suggestion && suggestion.id !== dismissed && online && !chat.runId && !composer.text;
  const error = [
    chat.action.error,
    chat.stopAction.error,
    composer.action.error,
    topics.action.error,
    topics.write.error,
    workplace.write.error,
    changes.write.error,
    groupPlan.write.error,
    yolo.write.error,
    mode.write.error,
    retry.action.error,
    question.action.error,
    compact.action.error,
    compact.cancelAction.error,
    approvals.action.error,
  ].find(Boolean);
  return {
    kind,
    id,
    entry,
    scope,
    online,
    connecting,
    reconnecting,
    topics,
    chat,
    workplace,
    plan,
    groupPlan,
    changes,
    yolo,
    mode,
    retry,
    question,
    compact,
    runInfo,
    browser,
    composer,
    approvals,
    pending,
    error,
    stopNotice,
    setStopNotice,
    suggestion: showSuggestion ? suggestion : undefined,
    dismissSuggestion: () => setDismissed(suggestion?.id),
    lookFor: (botId: string | null | undefined) => {
      if (kind === "bot") return entry?.looks[0];
      const bot = botId ? conversations.bots.get(botId) : undefined;
      return bot
        ? { name: bot.name, shape: bot.avatarShape, color: bot.avatarColor, eyes: bot.avatarEyes }
        : undefined;
    },
  };
}
export type ChatPage = ReturnType<typeof useChatPage>;
