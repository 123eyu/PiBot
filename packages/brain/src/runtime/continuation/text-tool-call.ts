/**
 * A model sometimes prints a tool call as XML text (`<ask_user>…</ask_user>`) instead of
 * calling it. Nothing runs, the user sees markup, and an automatic continuation could mistake it
 * for a delivery. Only a complete element whose name is a tool the product actually knows counts;
 * naming a tool in prose, a partial tag or an unknown name must keep the reply untouched.
 *
 * Markup inside Markdown code is an example, not a call. A fenced block or a backtick span
 * renders as code, so someone asking the Bot to show the format (or the Bot illustrating it) must
 * not be told to call the tool instead. Those regions are blanked before matching.
 */
const escapeTag = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Blank fenced blocks and inline code, keeping one line per input line so prose on either side of
 * a block cannot be glued into a tag that was never written. An unclosed fence hides the rest of
 * the reply, which is also how Markdown renders it.
 */
function withoutCodeSpans(text: string): string {
  const kept: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split("\n")) {
    if (fence) {
      // CommonMark closes a fence with the same character, at least as long, and nothing after it.
      if (new RegExp(`^\\s*${fence.char}{${fence.length},}\\s*$`).test(line)) fence = null;
      kept.push("");
      continue;
    }
    // Leading indentation is allowed so fences inside list items are skipped too.
    const run = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (run) {
      fence = { char: run.charAt(0), length: run.length };
      kept.push("");
      continue;
    }
    // Single-backtick spans cannot cross a line break; removing them keeps the surrounding prose
    // readable for the tag match.
    kept.push(line.replace(/`[^`\n]*`/g, ""));
  }
  return kept.join("\n");
}

export function textToolCallMarker(text: string, names: readonly string[]): string | null {
  const sample = text.trim();
  // A real reply can be long; markup beyond this cap is not worth another model request.
  if (!sample || sample.length > 50_000) return null;
  const prose = withoutCodeSpans(sample);
  for (const name of new Set(names)) {
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(name)) continue;
    const tag = escapeTag(name);
    // Opening + closing tag (any attributes/body) or a self-closing tag. The body is untrusted
    // model text, so it may contain newlines and nested markup.
    const element = new RegExp(
      `<${tag}(?:\\s[^<>]*)?>[\\s\\S]*?</${tag}\\s*>|<${tag}(?:\\s[^<>]*)?/>`,
      "u",
    );
    if (element.test(prose)) return name;
  }
  return null;
}

/** One reminder inside the existing run: same session, budget, permissions and cancellation. */
export function textToolCallCorrection(name: string) {
  return [
    `[Pi Bot tool call written as text] Your reply contained a ${name} call written as XML text. It did not run and is not a delivery. Call ${name} through the tool interface now, then answer from the actual result; do not repeat the markup. This is the only automatic reminder for this reply.`,
    `[正文里的工具调用] 你的回复把 ${name} 调用写成了 XML 文本。它没有执行，也不算交付。现在通过工具接口调用 ${name}，再按真实结果回答；不要重复这段标记。本轮最多提醒一次，沿原会话、预算、权限和取消。`,
  ].join("\n");
}
