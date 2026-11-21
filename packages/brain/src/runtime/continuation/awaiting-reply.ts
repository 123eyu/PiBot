// the model often ends a turn by asking the
// user a question, yet the TODO follow-through still starts another run and produces
// "继续" segments, empty bubbles and "还在等你回答" nudges. The judgement is done in
// code (no extra model call): a final turn without tool calls that closes with a
// question or an answer prompt means the bot is waiting for the user. A false positive
// only costs one extra "继续", but a false stop hides real progress, so only the
// closing block counts and option-like text must really look like options.
const answerHint =
  /回一个字母|回复字母|请回答|请选择|你选|选哪个|\breply with\b|\banswer with\b|\bchoose\b|\bwhich one\b|\bpick one\b/iu;
// Three or more consecutive single-letter options ("A/B/C", "A、B、C"): two are ordinary
// prose ("I/O", "A/B 测试") and must not pause the follow-through.
const optionRun = /(?<![A-Za-z0-9])(?:[A-Z][/、]){2,}[A-Z](?![A-Za-z0-9])/u;
// A lettered list line ("A. …", "A) …", "A：…", "- A …"); two or more read as choices.
const optionLine = /^(?:[-*]\s+[A-Z](?:\s|$)|[A-Z]\s*[.)：:]\s*\S)/u;
// Trailing markdown emphasis or a closing quote may sit after the question mark.
const trailingDecoration = /[\s*_~"'“”‘’」』)）\]]+$/u;
// Fenced code at the end is output, not a question; identifiers in it can contain hint words.
const codeFence = /```[\s\S]*?(?:```|$)/gu;
// Six lines cover a question plus its option list without reaching into a long report body.
const closingLines = 6;

/** True when the last assistant turn asks the user something and therefore needs a reply. */
export function awaitingReply(text: string, toolCalls: number): boolean {
  if (toolCalls !== 0) return false;
  const lines = text
    .replace(codeFence, "")
    .split(/\r?\n/u)
    .filter((line) => line.trim());
  const last = lines.at(-1)?.trim();
  if (!last) return false;
  const undecorated = last.replace(trailingDecoration, "");
  if (/[?？]$/u.test(undecorated)) return true;
  // A hint word buried in a long report body must not pause the follow-through, so only the
  // closing block can carry the question the user is expected to answer.
  const closing = lines.slice(-closingLines).map((line) => line.trim());
  return (
    closing.some((line) => answerHint.test(line)) ||
    optionRun.test(closing.join("\n")) ||
    closing.filter((line) => optionLine.test(line)).length >= 2
  );
}
