/**
 * On chat-completions APIs Pi Bot's runtime state travels as a user-side message after the
 * user's own one (`RunStates`), and a text-transforming Bot can take it for more input: a
 * translator Bot on OpenRouter DeepSeek Flash translated "[Pi Bot runtime state #1 …]" with its
 * execution rules and plan data and sent it as part of the reply (maintainers, 2026-11-18). The state
 * header asks the model not to do that; this filter is the program-side guarantee.
 *
 * It drops everything from an echoed state header — "[Pi Bot runtime state #<n>" or its Chinese
 * forms, as the state text or a translation renders them — to the end of the assistant message,
 * where such an echo lands. A digit after "#" is required, so prose or code that names the marker
 * stays. While streaming, a trailing "[…" that could still become a header is held back until it
 * can be told apart (at most HOLD characters), then released or dropped.
 */
const HEADER = /\[\s*Pi\s*Bot\s*(?:runtime\s+state|(?:生成的)?运行状态)\s*#\s*\d/i;
const FORMS = ["[pi bot runtime state #", "[pi bot 运行状态 #", "[pi bot 生成的运行状态 #"];
const HOLD = 32;

const squash = (text: string) => text.toLowerCase().replace(/\s+/g, "");
// Whether `tail` may still grow into a header (compared without whitespace or case).
function couldBecome(tail: string): boolean {
  const t = squash(tail);
  return FORMS.some((form) => squash(form).startsWith(t));
}

export class LeakedStateEchoFilter {
  private pending = "";
  private dropping = false;
  /** An echo was cut from this message (for logging; the content is never logged). */
  leaked = false;

  /** Text that can be shown now. */
  push(delta: string): string {
    if (this.dropping) return "";
    const text = this.pending + delta;
    this.pending = "";
    const found = HEADER.exec(text);
    if (found) {
      this.dropping = true;
      this.leaked = true;
      return text.slice(0, found.index).trimEnd();
    }
    const last = text.lastIndexOf("[");
    if (last >= 0 && text.length - last <= HOLD && couldBecome(text.slice(last))) {
      this.pending = text.slice(last);
      return text.slice(0, last);
    }
    return text;
  }

  /** End of the assistant message: release a held "[…" that never became a header. */
  end(): string {
    const rest = this.dropping ? "" : this.pending;
    this.pending = "";
    this.dropping = false;
    return rest;
  }
}
