import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type { PromptContext } from "../core/types.ts";
import {
  type Anchor,
  anchorAfter,
  customMessage,
  entryId,
  highestState,
  placeCreated,
  STATE_TYPE,
  stateDetailsFor,
  stateEntry,
  type TranscriptPort,
} from "./transcript-entries.ts";
import { stateBody, stateText } from "./volatile-state.ts";

type Message = ContextEvent["messages"][number];

/**
 * Pi Bot's trusted state messages. Numbers count up across the whole session, so "the
 * highest number wins" holds in every request even when states of earlier runs are in it.
 *
 * Every provider uses the append-only layout (maintainers 2026-11-18; until then only the
 * ChatGPT/Codex backend did): a state is sent once, where it first appeared, and is
 * written to the session transcript at that point, so every later request of this run and
 * of later runs carries it byte-identical in place. A new, higher-numbered state is added only when
 * the content differs from the newest one the request already shows (also across runs: an
 * unchanged plan adds nothing at a run's start). Earlier states are never edited or annotated.
 *
 * Pi Bot messages that directly follow a user message are shown right before it
 * (`beforeUserMessage`): on chat-completions APIs they are user-side messages, and a translator Bot
 * on DeepSeek Flash took a state that came after the user's message for the latest input
 * (2026-11-18). The rule is applied to every request, so a run's own requests and later runs, which
 * replay the transcript, show the same order and keep one cached prefix (OpenCode likewise puts its
 * frozen instruction update before the user prompt).
 */
export class RunStates {
  private created: { anchor: Anchor; message: Message }[] = [];
  /** Highest number used in this session; read from the transcript once per run. */
  private highest?: number;

  constructor(private readonly transcript?: TranscriptPort) {}

  /** A new run (pi's before_agent_start). */
  reset() {
    this.created = [];
    this.highest = undefined;
  }

  /** This request's conversation with the state message(s) in place, and their exact texts. */
  apply(messages: Message[], current: PromptContext | undefined) {
    const body = stateBody(current);
    if (body === undefined) {
      // Pi Bot stopped reporting a state: show none rather than stale limits, including states
      // persisted by earlier runs. Rare, and costs one cache miss. The counter is untouched, so a
      // later state can never reuse a number.
      this.created = [];
      return {
        messages: beforeUserMessage(messages.filter((m) => !stateEntry(m))),
        texts: new Set<string>(),
      };
    }
    let out = placeCreated(messages, this.created);
    const shown = out.flatMap((m) => stateEntry(m) ?? []);
    this.highest = Math.max(
      this.highest ?? highestState(this.transcript?.entries() ?? []),
      ...shown.map((state) => state.number),
    );
    const newest = shown.at(-1);
    if (!newest || newest.text !== stateText(newest.number, body)) {
      const details = stateDetailsFor(++this.highest);
      const text = stateText(details.number, body);
      const content = [{ type: "text" as const, text }];
      const message = customMessage(STATE_TYPE, content, details);
      this.created.push({ anchor: anchorAfter(out), message });
      // Written where the request shows it: after the session's last entry.
      this.transcript?.append(STATE_TYPE, content, details);
      out = [...out, message];
      shown.push({ id: details.id, number: details.number, text });
    }
    return {
      messages: beforeUserMessage(out),
      texts: new Set(shown.map((state) => state.text)),
    };
  }
}

/**
 * Moves each run of Pi Bot messages (states, references) that directly follows a user message to
 * just before that message, keeping their order; nothing else moves. Pure and deterministic, so the
 * same transcript always renders the same request.
 */
export function beforeUserMessage(messages: Message[]): Message[] {
  const out: Message[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i] as Message;
    let end = i + 1;
    if (message.role === "user")
      while (end < messages.length && entryId(messages[end] as Message)) end++;
    if (end > i + 1) out.push(...messages.slice(i + 1, end), message);
    else out.push(message);
    i = end;
  }
  return out;
}
