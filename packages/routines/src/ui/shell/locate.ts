import type { MethodResults } from "@pibot/protocol";
import { type Peer, type View, waitRpc } from "@pibot/renderer-kit";

interface RunOwnership {
  routineId: string | null;
  messageBotId: string;
}

export async function routineRunTarget(
  peer: Peer,
  run: MethodResults["routines.trialResult"],
  signal: AbortSignal,
): Promise<View> {
  if (!run.conversationId) throw new Error("Run topic unavailable");
  let botId = run.botId;
  const routineId = run.routineId;
  if (routineId) {
    if (run.reason === "trial") throw new Error("Trial routine mismatch");
    const routine = await waitRpc(() => peer.call("routines.get", { id: routineId }), signal);
    if (routine.id !== routineId || routine.topicConversationId !== run.conversationId)
      throw new Error("Run routine topic mismatch");
    // Moving a routine transfers its topic, not the authorship of earlier runs or messages.
    botId = routine.botId;
  } else if (run.reason !== "trial") {
    throw new Error("Run routine missing");
  }
  return routineTarget(peer, botId, run.conversationId, run.triggerMessageId, signal, {
    routineId: run.routineId,
    messageBotId: run.botId,
  });
}

export async function plannedTarget(
  peer: Peer,
  point: MethodResults["routines.planned"]["points"][number],
  signal: AbortSignal,
): Promise<View> {
  const routine = await waitRpc(() => peer.call("routines.get", { id: point.routineId }), signal);
  if (routine.id !== point.routineId || routine.topicConversationId !== point.conversationId)
    throw new Error("Planned routine topic mismatch");
  // A plan has no execution or trigger message. Re-resolve ownership if its Bot has moved.
  return routineTarget(peer, routine.botId, point.conversationId, undefined, signal, {
    routineId: point.routineId,
    messageBotId: point.botId,
  });
}

export async function routineTarget(
  peer: Peer,
  botId: string,
  conversationId: string,
  messageId: string | null | undefined,
  signal: AbortSignal,
  ownership?: RunOwnership,
): Promise<View> {
  // Validate ownership before changing the current topic. History is scoped to that exact topic.
  const matches = (topic: MethodResults["topics.switch"]) =>
    topic.id === conversationId &&
    topic.botId === botId &&
    topic.kind === "dm" &&
    (!ownership || (topic.routineId ?? null) === ownership.routineId);
  let before: string | undefined;
  let found = false;
  for (let page = 0; page < 50; page++) {
    signal.throwIfAborted();
    const topics = await waitRpc(
      () => peer.call("topics.list", { botId, before, limit: 200 }),
      signal,
    );
    if (topics.some(matches)) {
      found = true;
      break;
    }
    if (topics.length < 200 || topics.at(-1)?.id === before) break;
    before = topics.at(-1)?.id;
  }
  if (!found) throw new Error("Topic target unavailable");
  if (messageId) {
    before = undefined;
    found = false;
    for (let page = 0; page < 50; page++) {
      signal.throwIfAborted();
      const messages = await waitRpc(
        () => peer.call("chat.history", { botId, topicId: conversationId, before, limit: 200 }),
        signal,
      );
      if (
        messages.some(
          (message) =>
            message.id === messageId &&
            message.conversationId === conversationId &&
            (!message.botId || message.botId === (ownership?.messageBotId ?? botId)),
        )
      ) {
        found = true;
        break;
      }
      if (messages.length < 200 || messages[0]?.id === before) break;
      before = messages[0]?.id;
    }
    if (!found) throw new Error("Message target unavailable");
  }
  const topic = await waitRpc(
    () => peer.call("topics.switch", { botId, topicId: conversationId }),
    signal,
  );
  signal.throwIfAborted();
  if (!matches(topic)) throw new Error("Topic ownership changed");
  return {
    name: "chat",
    botId,
    topicId: conversationId,
    ...(messageId ? { focus: { messageId } } : {}),
  };
}
