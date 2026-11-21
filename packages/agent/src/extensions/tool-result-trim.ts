import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent/context-helpers";
import { contextBudget } from "../runtime/context-budget.ts";
import { placeSystemMessages } from "./volatile-state.ts";

type Message = ContextEvent["messages"][number];

const MIN_CHARS = 4000;
const HEAD_CHARS = 1500;
const TAIL_CHARS = 1000;
/**
 * After a checkpoint failed to get under the trigger, a retained result over
 * `MIN_CHARS` becomes three lines of head and three of tail. It shares the trimmer's threshold
 * because a result the model has not asked to see again costs the same either way; smaller ones
 * together stay inside one checkpoint tail, so collapsing them would lose detail for no gain.
 */
const COLLAPSE_LINES = 3;
const COLLAPSE_SIDE_CHARS = 400;
/** Insurance for tiny windows: the newest results stay whole whatever their size. */
const NEWEST_RESULTS = 2;
/**
 * Maintainers 2026-10-22, "as fast as Claude Code / Codex": reference material the model has
 * already used — pages, file reads, listings, command output — is trimmed once the context passes
 * this size, instead of waiting for half the compaction trigger (~80k on large windows). Measured:
 * 72% of a slow Bot's history was 23 web pages, so a one-line reply re-sent 111k tokens.
 */
const EARLY_TRIM_TOKENS = 24_000;
const REFERENCE_TOOLS = new Set([
  "web_fetch",
  "web_search",
  "read_file",
  "list_dir",
  "find_files",
  "search_text",
  "run_command",
  "office_preview",
  "office_render",
  "office_inspect",
]);

// Never split a UTF-16 surrogate pair: a lone surrogate makes some providers reject the JSON.
function head(text: string, end: number) {
  const code = text.charCodeAt(end - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
}
function tail(text: string, start: number) {
  const code = text.charCodeAt(start);
  return text.slice(code >= 0xdc00 && code <= 0xdfff ? start + 1 : start);
}

// Line boundaries keep the collapsed copy readable when the result is a file or a log; the char
// caps keep a single-line result (minified JSON, one-line error) from staying long.
function lineEnd(text: string, lines: number) {
  let end = 0;
  for (let n = 0; n < lines; n++) {
    const next = text.indexOf("\n", end);
    if (next < 0) return text.length;
    end = next + 1;
  }
  return end;
}
function lineStart(text: string, lines: number) {
  let start = text.length;
  for (let n = 0; n < lines && start > 0; n++) {
    const previous = text.lastIndexOf("\n", start - 1);
    start = previous < 0 ? 0 : previous;
  }
  return start;
}

// Depends only on the text, so the same result is cut identically on every request and run.
export function shortenToolText(text: string) {
  if (text.length <= MIN_CHARS) return text;
  return `${head(text, HEAD_CHARS)}\n…[已截短：较早的工具输出，原长 ${text.length} 字，保留开头和结尾；需要完整内容请重新调用工具 / trimmed older tool output, originally ${text.length} chars; head and tail kept, re-run the tool if the full output is needed]…\n${tail(text, text.length - TAIL_CHARS)}`;
}

/**
 * The last resort before reporting `context_overflow`. A checkpoint never touches the
 * tail pi keeps verbatim, so a few whole-file reads or long logs there hold the estimate above the
 * trigger however often we summarize. This copy keeps only the tool name, the original length and
 * the first and last lines; the session file, the run records and the audit log keep the originals
 * (only the request is changed). Depends only on the result text, so a retry sends the same bytes.
 */
export function collapseToolText(text: string, toolName: string) {
  if (text.length <= MIN_CHARS) return text;
  const headText = head(text, Math.min(lineEnd(text, COLLAPSE_LINES), COLLAPSE_SIDE_CHARS));
  const tailText = tail(
    text,
    Math.max(lineStart(text, COLLAPSE_LINES), text.length - COLLAPSE_SIDE_CHARS),
  );
  return `${headText}\n…[上下文仍超出窗口，较早的工具输出已折叠：${toolName}，原长 ${text.length} 字，只保留开头和结尾几行；需要时重新运行或重新读取 / collapsed to fit the window: ${toolName}, originally ${text.length} chars, first and last lines kept; re-run or re-read it when needed]…\n${tailText}`;
}

/**
 * Shortens long tool results that are no longer recent, in the request copy only. Reference
 * results from older user turns are shortened earlier (`earlyReferenceTrim`).
 *
 * "Recent" is roughly the newest keepRecentTokens, the same tail pi keeps verbatim when it
 * compacts, so trimming only touches what a compaction would summarize anyway. User turns are
 * not the boundary: one routine or computer-use turn can hold dozens of long results.
 *
 * Every change to an already-sent message breaks the provider's prompt cache from that point,
 * so the output must not flip and should change rarely: trimming starts only past half the
 * compaction trigger; the cut is a position from the start, measured on the untrimmed history
 * (never on our own output), so it only moves forward between compactions; it moves in steps
 * of half keepRecentTokens, so results are shortened in batches rather than one per request;
 * and the shortened text depends only on the result itself.
 *
 * `collapseRecent` is the last resort: the retained tail is collapsed too, because a
 * checkpoint that already failed cannot shrink it (see `collapseToolText`).
 */
export function trimOlderToolResults(
  messages: Message[],
  contextWindow: number,
  collapseRecent = false,
) {
  const base = (collapseRecent ? collapseRecentToolResults(messages) : undefined) ?? messages;
  const budget = contextBudget(contextWindow);
  const tokens = base.map((message) => estimateTokens(message));
  let total = 0;
  for (const n of tokens) total += n;
  const early = earlyReferenceTrim(base, total);
  if (total <= budget.trimFromTokens) return early;
  const step = Math.max(1, Math.floor(budget.keepRecentTokens / 2));
  const cut = Math.floor((total - budget.keepRecentTokens) / step) * step;
  let newest = base.length;
  let kept = 0;
  while (newest > 0 && kept < NEWEST_RESULTS) {
    newest--;
    if (base[newest]?.role === "toolResult") kept++;
  }
  let end = 0;
  let changed = base !== messages || !!early;
  const trimmed = early ?? base.slice();
  for (let i = 0; i < newest; i++) {
    end += tokens[i] ?? 0;
    if (end > cut) break;
    const message = base[i] as Message;
    if (!trimmable(message)) continue;
    changed = true;
    trimmed[i] = shortened(message);
  }
  return changed ? trimmed : undefined;
}

/**
 * Collapses every oversized result of the history the next request keeps verbatim, except the
 * newest ones: the tool call this turn just made must stay readable. The estimate that decides
 * whether a checkpoint helped has to count the same copy, so both callers use this function.
 */
export function collapseRecentToolResults(messages: Message[]): Message[] | undefined {
  let newest = messages.length;
  let kept = 0;
  while (newest > 0 && kept < NEWEST_RESULTS) {
    newest--;
    if (messages[newest]?.role === "toolResult") kept++;
  }
  let collapsed: Message[] | undefined;
  for (let i = 0; i < newest; i++) {
    const message = messages[i] as Message;
    if (!trimmable(message)) continue;
    collapsed ??= messages.slice();
    collapsed[i] = {
      ...message,
      content: message.content.map((part) =>
        part.type === "text"
          ? { ...part, text: collapseToolText(part.text, message.toolName) }
          : part,
      ),
    };
  }
  return collapsed;
}

function trimmable(message: Message): message is Extract<Message, { role: "toolResult" }> {
  return (
    message.role === "toolResult" &&
    !message.isError &&
    // Memory tools stay verbatim: their results are what the Bot is meant to remember.
    !message.toolName.startsWith("memory_") &&
    message.content.some((part) => part.type === "text" && part.text.length > MIN_CHARS)
  );
}

// Same id, name and position: the tool call/result pairing providers validate is untouched.
function shortened(message: Extract<Message, { role: "toolResult" }>): Message {
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === "text" ? { ...part, text: shortenToolText(part.text) } : part,
    ),
  };
}

/**
 * Reference results from turns before the previous user turn: the model has used them and
 * answered at least one more message since. The previous turn stays whole, so a follow-up such as
 * "summarize the page you just read" still sees it. The boundary moves only when a new user
 * message arrives, so within a turn every request keeps the same prefix (prompt cache).
 */
function earlyReferenceTrim(messages: Message[], total: number): Message[] | undefined {
  if (total <= EARLY_TRIM_TOKENS) return undefined;
  let users = 0;
  let boundary = -1;
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i]?.role === "user" && ++users === 2) {
      boundary = i;
      break;
    }
  let trimmed: Message[] | undefined;
  for (let i = 0; i < boundary; i++) {
    const message = messages[i] as Message;
    if (!trimmable(message) || !REFERENCE_TOOLS.has(message.toolName)) continue;
    trimmed ??= messages.slice();
    trimmed[i] = shortened(message);
  }
  return trimmed;
}

export function registerToolResultTrim(pi: ExtensionAPI, state?: { collapseRecent?: boolean }) {
  // Registered before the group context hook, so its byte budget sees the shortened results.
  // pi hands context handlers a structured clone; the session JSONL and the messages pi
  // estimates from keep full text. pi's next threshold check uses the provider's usage for
  // this (shortened) request, so trimming also postpones compaction. A
  // `context_with_system` hook, like the prompt context hook, so pi keeps its system messages
  // (tool and prompt updates) in place; they are left out of the estimate and put back as they
  // were (trimming maps messages one to one).
  pi.on("context_with_system", (event, ctx) => {
    if (!ctx.model) return;
    const conversation = event.messages.filter((m) => m.role !== "system");
    const trimmed = trimOlderToolResults(
      conversation,
      ctx.model.contextWindow,
      state?.collapseRecent,
    );
    if (!trimmed) return;
    let next = 0;
    const messages = event.messages.map((m) =>
      m.role === "system" ? m : (trimmed[next++] as Message),
    );
    return { messages: placeSystemMessages(messages, ctx.model) };
  });
}
