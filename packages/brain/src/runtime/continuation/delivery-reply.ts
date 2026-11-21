/**
 * DeepSeek often writes a whole deliverable into the reply (storyboard, PRD, post pack,
 * fact-check) and stops after 2–4 requests without ever calling a write tool, even though the
 * delivery rule already says to save documents as files. The program therefore sends one fixed
 * reminder at the end of the first request. This module only decides; it never writes anything and
 * never executes reply content.
 *
 * The thresholds come from the fifth DeepSeek eval round (`2026-11-08T05-20-41.527Z`, role cases):
 * document-shaped replies that needed a file were 1.2k–2.9k characters after code blocks were
 * removed and carried at least two headings or tables, while ordinary answers stayed well below
 * 1.2k. Counting prose only keeps a long code sample or a log dump from looking like a document.
 */
export const DELIVERY_REPLY_MIN_CHARS = 1200;

/** Headings plus tables: one heading alone is still a chat answer, two sections or a table is not. */
export const DELIVERY_REPLY_MIN_MARKERS = 2;

const heading = /^\s{0,3}#{1,6}\s+\S/u;
const tableRow = /^\s*\|.*\|\s*$/u;
// Trailing emphasis or a closing quote may follow the question mark of a question-only reply.
const trailingDecoration = /[\s*_~"'“”‘’」』)）\]]+$/u;
// Fenced code is output, not prose; an unclosed fence hides the rest, as Markdown renders it.
const codeFence = /^ {0,3}(`{3,}|~{3,})/u;

/** Explicit delivery claims only; a bare mention of an attachment is not enough. */
const ATTACHMENT_CLAIM =
  /(?:已(?:经)?(?:附上|就位|生成|保存到|写入|交付|发送(?:了)?(?:文件|截图|附件))|(?:文件|截图)已发送|(?:我|我已经|我已)附上(?:了)?(?:文件|截图|附件)|(?:I've|I\s+have)\s+(?:attached|sent)\s+(?:the\s+)?(?:file|screenshot)|(?:the\s+)?(?:file|screenshot)\s+is\s+(?:attached|ready)|saved\s+to|generated)/iu;

/** Prose with code blocks blanked out, one line per input line so layout is preserved. */
function withoutFences(text: string): string {
  const kept: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split("\n")) {
    if (fence) {
      if (new RegExp(`^\\s*${fence.char}{${fence.length},}\\s*$`).test(line)) fence = null;
      kept.push("");
      continue;
    }
    const run = codeFence.exec(line)?.[1];
    if (run) {
      fence = { char: run.charAt(0), length: run.length };
      kept.push("");
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * A quote or code sample is reference material, not the assistant's delivery claim. Keep this
 * check deliberately narrow: the follow-up costs a model turn, so ordinary attachment discussion
 * must not trigger it.
 */
export function claimsFileDelivery(
  text: string,
  facts: { hasUserAttachments?: boolean; hasShownImages?: boolean } = {},
): boolean {
  const contextual =
    !facts.hasUserAttachments && !facts.hasShownImages
      ? /(?:附件(?:如下|已附上)|见附件|截图如下)/iu
      : undefined;
  return withoutFences(text)
    .split("\n")
    .filter((line) => !/^\s*>/u.test(line))
    .filter((line) => !/^\s*(?:用户原话|用户说|user(?:'s)?\s+(?:quote|said))\s*:/iu.test(line))
    .some((line) => ATTACHMENT_CLAIM.test(line) || contextual?.test(line) === true);
}

/** Headings plus one mark per contiguous table block (a table is one section, not each row). */
function documentMarkers(lines: readonly string[]): number {
  let markers = 0;
  let inTable = false;
  for (const line of lines) {
    if (tableRow.test(line)) {
      if (!inTable) markers += 1;
      inTable = true;
      continue;
    }
    inTable = false;
    if (heading.test(line)) markers += 1;
  }
  return markers;
}

export interface DeliveryReplyFacts {
  /** Only a completed answer can be a deliverable; length stop or abort has its own path. */
  stopReason: string;
  reply: string;
  /** A write_file / edit_file / apply_patch / office write really succeeded in this run. */
  wroteFiles: boolean;
  /** Without a working folder there is nowhere the delivery rule could put a file. */
  hasWorkplace: boolean;
  /**
   * Group runs deliver through the plan and step contract (coordinator summary, status notes), so a
   * document-shaped answer there is not a missing file; research-group needs group_plan instead.
   */
  inGroup: boolean;
  /** The user's message of this run, to tell a transformed paste from a new document. */
  userText?: string;
  /**
   * A read-only Bot (write_file level never) cannot save the file the reminder asks for,
   * so reminding it only pushes it into a refused write — the sixth DeepSeek round hit exactly
   * that with code-reviewer.
   */
  writeFileNever: boolean;
}

/**
 * True when the reply itself is the deliverable and a file should exist instead. A reply that only
 * asks the user something (closes with a question and is a single paragraph) is conversation, not a
 * deliverable, so it must not trigger the reminder.
 */
/**
 * The reply transforms a document the user pasted (translation, proofreading, rewriting): the
 * user's own message is itself document-shaped and at least half as long. The answer then belongs
 * in the chat; a translator Bot asked to file every translation learned to write a file first on
 * every message (2026-11-18).
 */
function transformsPastedDocument(reply: string, userText: string | undefined) {
  if (!userText) return false;
  const pasted = withoutFences(userText).trim();
  return (
    documentMarkers(pasted.split("\n")) >= DELIVERY_REPLY_MIN_MARKERS &&
    [...pasted].length * 2 >= [...reply].length
  );
}

export function deliveryOnlyInReply(facts: DeliveryReplyFacts): boolean {
  if (
    facts.stopReason !== "stop" ||
    facts.wroteFiles ||
    !facts.hasWorkplace ||
    facts.inGroup ||
    facts.writeFileNever
  )
    return false;
  const prose = withoutFences(facts.reply).trim();
  if ([...prose].length < DELIVERY_REPLY_MIN_CHARS) return false;
  if (documentMarkers(prose.split("\n")) < DELIVERY_REPLY_MIN_MARKERS) return false;
  if (transformsPastedDocument(prose, facts.userText)) return false;
  const lastLine = prose.split("\n").at(-1)?.trim() ?? "";
  const paragraphs = prose.split(/\n\s*\n/u).filter((part) => part.trim()).length;
  const asksOnly = /[?？]$/u.test(lastLine.replace(trailingDecoration, "")) && paragraphs <= 1;
  return !asksOnly;
}
