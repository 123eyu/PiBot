// Adds a persisted, redacted acknowledgement to the reply associated with a correction.
import type { DatabaseSync } from "node:sqlite";
import type { BrainRedactor } from "@pibot/brain/kit";
import { MemoryNotedSchema } from "@pibot/protocol-base";
import { MessagesRepo } from "@pibot/storage";

export function recordCorrectionReceipt(
  db: DatabaseSync,
  replyId: string,
  notes: { id: string; text: string }[],
  redactor: BrainRedactor,
) {
  const messages = new MessagesRepo(db);
  const reply = messages.get(replyId);
  if (reply?.status !== "done") return undefined;
  const usage =
    reply.usage && typeof reply.usage === "object" && !Array.isArray(reply.usage)
      ? reply.usage
      : {};
  const memoryNoted = MemoryNotedSchema.parse(
    [...new Map(notes.map((note) => [note.id, note])).values()].map(({ id, text }) => ({
      id,
      text: redactor.redact(text).slice(0, 500),
    })),
  );
  return messages.update(reply.id, { usage: { ...usage, memoryNoted } });
}
