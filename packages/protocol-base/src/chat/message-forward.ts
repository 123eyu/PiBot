import { z } from "zod";
import { MAX_ATTACHMENTS } from "./attachments.ts";

/**
 * FORWARD-DISPLAY: what a forwarded user message shows instead of its model text. The model still
 * receives the full untrusted material in `content`; this is a bounded, already-redacted subset of
 * that same text, so it never carries anything the message text does not. A display hint only: it
 * never grants access to the source conversation and is never sent back to a model.
 */
export const FORWARD_LIMITS = {
  messages: 50,
  name: 200,
  text: 2000,
  quote: 500,
  /** Total characters of record text and quotes, so history pages stay within relay frames. */
  total: 24_000,
  summary: 12_000,
  note: 4000,
} as const;

const ForwardRecordSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  sender: z.string().max(FORWARD_LIMITS.name),
  at: z.iso.datetime(),
  text: z.string().max(FORWARD_LIMITS.text),
  quoted: z
    .strictObject({
      sender: z.string().max(FORWARD_LIMITS.name),
      text: z.string().max(FORWARD_LIMITS.quote),
    })
    .optional(),
  attachments: z
    .array(z.strictObject({ name: z.string().max(255), kind: z.enum(["image", "file"]) }))
    .max(MAX_ATTACHMENTS),
});
export const MessageForwardSchema = z.strictObject({
  messageCount: z.number().int().min(1).max(FORWARD_LIMITS.messages),
  source: z.strictObject({
    chat: z.string().max(FORWARD_LIMITS.name),
    topic: z.string().max(FORWARD_LIMITS.name),
  }),
  messages: z.array(ForwardRecordSchema).max(FORWARD_LIMITS.messages),
  /** Some record text was cut for display; the model text is always complete. */
  truncated: z.boolean(),
  summary: z.string().max(FORWARD_LIMITS.summary).optional(),
  note: z.string().max(FORWARD_LIMITS.note).optional(),
});
export type MessageForward = z.infer<typeof MessageForwardSchema>;
export type MessageForwardRecord = z.infer<typeof ForwardRecordSchema>;

export function messageForward(message: { usage: unknown }): MessageForward | undefined {
  const usage = message.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
  const result = MessageForwardSchema.safeParse((usage as Record<string, unknown>).forward);
  return result.success ? result.data : undefined;
}

/** The text a person wrote: a forward's note (or nothing), otherwise the message itself. */
export function messageVisibleText(message: { content: string; usage: unknown }): string {
  const forward = messageForward(message);
  return forward ? (forward.note ?? "") : message.content;
}

/**
 * Where a reply's answer starts: a run's progress notes come first in `content` and the chat folds
 * them under 过程说明 at `usage.progressTextStart`. Other producers carry no boundary and are never
 * guessed from prose; 0 means "all answer". `text` is what will be shown (it must still be `content`).
 */
export function replyProgressStart(
  message: { content: string; usage: unknown; taskResult?: unknown },
  text: string,
): number {
  const usage = message.usage;
  const boundary =
    usage && typeof usage === "object" && !Array.isArray(usage)
      ? (usage as { progressTextStart?: unknown }).progressTextStart
      : undefined;
  return text === message.content &&
    !message.taskResult &&
    typeof boundary === "number" &&
    Number.isSafeInteger(boundary) &&
    boundary > 0 &&
    boundary < text.length
    ? boundary
    : 0;
}

/** The answer part of a reply, for one-line summaries such as the sidebar preview. */
export function messageAnswerText(message: {
  content: string;
  usage: unknown;
  taskResult?: unknown;
}): string {
  const text = messageVisibleText(message);
  return text.slice(replyProgressStart(message, text));
}

/** Cuts already-redacted records to the display limits; the caller's text stays authoritative. */
export function boundMessageForward(input: {
  source: { chat: string; topic: string };
  messages: readonly MessageForwardRecord[];
  summary?: string;
  note?: string;
}): MessageForward {
  let truncated = false,
    budget: number = FORWARD_LIMITS.total;
  const cut = (value: string, max: number) => {
    const limit = Math.max(0, Math.min(max, budget));
    if (value.length > limit) truncated = true;
    const kept = value.slice(0, limit);
    budget -= kept.length;
    return kept;
  };
  const name = (value: string) => value.slice(0, FORWARD_LIMITS.name);
  const messages = input.messages.slice(0, FORWARD_LIMITS.messages).map((record) => ({
    role: record.role,
    sender: name(record.sender),
    at: record.at,
    text: cut(record.text, FORWARD_LIMITS.text),
    ...(record.quoted
      ? {
          quoted: {
            sender: name(record.quoted.sender),
            text: cut(record.quoted.text, FORWARD_LIMITS.quote),
          },
        }
      : {}),
    attachments: record.attachments.slice(0, MAX_ATTACHMENTS).map((a) => ({
      name: a.name.slice(0, 255),
      kind: a.kind,
    })),
  }));
  return MessageForwardSchema.parse({
    messageCount: Math.max(1, Math.min(FORWARD_LIMITS.messages, input.messages.length)),
    source: { chat: name(input.source.chat), topic: name(input.source.topic) },
    messages,
    truncated,
    ...(input.summary ? { summary: input.summary.slice(0, FORWARD_LIMITS.summary) } : {}),
    ...(input.note ? { note: input.note.slice(0, FORWARD_LIMITS.note) } : {}),
  });
}
