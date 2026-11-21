import type { AttachmentInput } from "@pibot/protocol";
import { waitRpc } from "../rpc/wait.ts";
import { groupRequestError } from "./request-error.ts";
import type { GroupSession } from "./session.ts";
/** `mentions`: Bots picked from the @ list, so the brain never resolves `@name` by name alone. */
export async function send(
  this: GroupSession,
  text: string,
  attachments: AttachmentInput[],
  mentions: string[] = [],
  replyToMessageId?: string,
) {
  if (
    !this.active ||
    !this.state.confirmed ||
    this.state.sending ||
    this.state.requestError === "uncertain"
  )
    return false;
  this.publish({ sending: true, requestError: undefined });
  const generation = this.generation;
  try {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(35_000)]);
    let conversationId = this.target.conversationId;
    if (this.target.draftId) {
      const topic = await this.peer.call(
        "groups.topics.create",
        {
          groupId: this.target.groupId,
          requestId: this.target.draftId,
          selection: this.target.draftSelection,
        },
        { signal, timeoutMs: 30000 },
      );
      if (topic.id !== this.target.groupId || topic.topicArchivedAt)
        throw new Error("Created topic mismatch");
      conversationId = topic.conversationId;
    }
    const receipt = await waitRpc(
      () =>
        this.peer.call(
          "chat.send",
          {
            groupId: this.target.groupId,
            threadId: this.target.threadId,
            topicId: conversationId,
            text,
            ...(replyToMessageId ? { replyToMessageId } : {}),
            ...(attachments.length ? { attachments } : {}),
            ...(mentions.length && !this.target.threadId ? { mentions } : {}),
          },
          { signal },
        ),
      signal,
    );
    signal.throwIfAborted();
    if (generation !== this.generation) return false;
    if (
      receipt.conversationId !== conversationId ||
      receipt.groupId !== this.target.groupId ||
      receipt.threadId !== this.target.threadId
    )
      throw new Error("Wrong receipt");
    this.publish({ acceptedConversationId: conversationId });
    await this.refresh();
    return this.active && generation === this.generation;
  } catch (error) {
    if (generation === this.generation && !this.lifetime.signal.aborted) {
      this.publish({ requestError: groupRequestError(error) });
      this.schedule();
    }
    return false;
  } finally {
    if (generation === this.generation) this.publish({ sending: false });
  }
}
