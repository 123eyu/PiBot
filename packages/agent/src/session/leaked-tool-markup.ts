/**
 * DeepSeek models sometimes write their native tool-call markup (`<｜DSML｜function_calls>` …
 * `</｜DSML｜function_calls>`) into the reply text instead of returning an API tool call (seen
 * 2026-11-05 with OpenRouter deepseek-v4.1-flash: `<｜DSML｜invoke name="grep-nothing-ignore" />`
 * shown as a chat message). Nothing runs from that text, so it is only noise for the reader.
 *
 * The filter drops everything from the first marker to the end of that assistant message: the
 * markup sits at the end of a message, and a partial tool call has no readable tail worth keeping.
 * While streaming, a trailing `<…` that could still become a marker is held back until it can be
 * told apart, then released (or dropped) — never more than a few characters.
 */
const MARKER = /<\/?\s*[｜|]\s*DSML\s*[｜|]/;
// A possibly unfinished marker at the end of the pending text.
const PARTIAL = /^<(?:\/)?\s*(?:[｜|]\s*(?:D(?:S(?:M(?:L\s*)?)?)?)?)?$/;
const HOLD = 16;

export class LeakedToolMarkupFilter {
  private pending = "";
  private dropping = false;
  /** Markup was seen in this message (for logging; the content is never logged). */
  leaked = false;

  /** Text that can be shown now. */
  push(delta: string): string {
    if (this.dropping) return "";
    const text = this.pending + delta;
    this.pending = "";
    const found = MARKER.exec(text);
    if (found) {
      this.dropping = true;
      this.leaked = true;
      return text.slice(0, found.index).trimEnd();
    }
    const last = text.lastIndexOf("<");
    if (last >= 0 && text.length - last <= HOLD && PARTIAL.test(text.slice(last))) {
      this.pending = text.slice(last);
      return text.slice(0, last);
    }
    return text;
  }

  /** End of the assistant message: release a held `<…` that never became a marker. */
  end(): string {
    const rest = this.dropping ? "" : this.pending;
    this.pending = "";
    this.dropping = false;
    return rest;
  }
}
