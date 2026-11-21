import { GroupQuickStartsSchema, type Message } from "@pibot/protocol";
import { Button } from "@pibot/ui";
import styles from "../../chat/chat.module.css";

function quickStarts(message: Message) {
  if (message.role !== "assistant" || message.runId || message.status !== "done") return;
  const usage = message.usage;
  const parsed = GroupQuickStartsSchema.safeParse(
    usage && typeof usage === "object" && !Array.isArray(usage)
      ? usage.groupQuickStarts
      : undefined,
  );
  return parsed.success ? parsed.data : undefined;
}

/** Old welcomes stored the same list twice; hide only the exact program-generated suffix. */
export function quickStartCardMessage(message: Message): Message {
  const starts = quickStarts(message);
  if (!starts?.length) return message;
  const list = starts.map((text) => `- ${text}`).join("\n");
  for (const heading of ["可以这样开始：", "Try starting with:"]) {
    const suffix = `${heading}\n${list}`;
    if (message.content === suffix || message.content.endsWith(`\n\n${suffix}`))
      return { ...message, content: message.content.slice(0, -suffix.length).trimEnd() };
  }
  return message;
}

/**
 * Program-created welcome metadata, never parsed out of model Markdown. Each entry is an
 * example request; a click only puts it in the composer, so the user edits it before sending and
 * the coordinator plans from what was actually sent.
 */
export function GroupQuickStarts({
  message,
  fill,
  disabled,
}: {
  message: Message;
  fill?(text: string): void;
  disabled: boolean;
}) {
  const starts = fill ? quickStarts(message) : undefined;
  if (!starts) return null;
  return (
    <div className={styles.suggestions}>
      {[...new Set(starts)].map((text) => (
        <Button key={text} variant="secondary" disabled={disabled} onClick={() => fill?.(text)}>
          {text}
        </Button>
      ))}
    </div>
  );
}
