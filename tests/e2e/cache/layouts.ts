import {
  REFERENCE_MARKER,
  STATE_MARKER,
} from "../../../packages/agent/src/extensions/volatile-state.ts";

type Json = Record<string, unknown>;

const firstText = (item: Json | undefined) => {
  if (typeof item?.content === "string") return item.content;
  const parts = Array.isArray(item?.content) ? (item.content as Json[]) : [];
  const text = parts.find((part) => part.type === "input_text")?.text;
  return typeof text === "string" ? text : "";
};
const isState = (item: Json) => firstText(item).startsWith(STATE_MARKER);
const isReference = (item: Json) =>
  item.role === "user" && firstText(item).startsWith(REFERENCE_MARKER);

/** Splits a captured Responses body into its other items and its newest state item. */
function split(body: Json) {
  const copy = structuredClone(body);
  const input = (copy.input as Json[] | undefined) ?? [];
  const states = input.filter(isState);
  return { copy, input, newest: states.at(-1) };
}

/**
 * The single-message layout Pi Bot once sent: one trailing user message carrying the newest
 * state and the whole reference (group runs rebuilt it on every request), nothing in between.
 */
export function singleMessageLayout(body: Json): Json {
  const { copy, input, newest } = split(body);
  const references = input.filter(isReference);
  if (!newest && !references.length) return copy;
  const rest = input.filter((item) => !isState(item) && !references.includes(item));
  rest.push({
    role: "user",
    content: [
      ...((newest?.content as Json[] | undefined) ?? []),
      ...references.flatMap((item) => (item.content as Json[] | undefined) ?? []),
    ],
  });
  copy.input = rest;
  return copy;
}

/**
 * References where they are, only the newest state, re-sent at the end of every request
 * (with the role the hook gave it, developer on GPT-5.6+/Codex-shaped models).
 */
export function trailingStateLayout(body: Json): Json {
  const { copy, input, newest } = split(body);
  if (!newest) return copy;
  copy.input = [...input.filter((item) => !isState(item)), newest];
  return copy;
}

/**
 * Conversation messages that start runs (user and member turns, not Pi Bot's reference or state
 * messages). Two requests with the same count belong to the same run.
 */
export const turns = (body: Json) =>
  ((body.input as Json[] | undefined) ?? []).filter(
    (item) => item.role === "user" && !isReference(item) && !isState(item),
  ).length;

/**
 * Where Pi Bot's messages sit, e.g. `tools=31 ref@5 state#1@6/developer tools+3@9 ref@11`:
 * top-level tool count, then references, states and in-place tool loads.
 */
export function layout(body: Json) {
  const input = (body.input as Json[] | undefined) ?? [];
  const tools = `tools=${Array.isArray(body.tools) ? body.tools.length : 0}`;
  return [
    tools,
    ...input.flatMap((item, i) => {
      if (item.type === "additional_tools")
        return [`tools+${Array.isArray(item.tools) ? item.tools.length : 0}@${i}`];
      const text = firstText(item);
      if (text.startsWith(REFERENCE_MARKER)) return [`ref@${i}`];
      if (text.startsWith(STATE_MARKER))
        return [
          `state${/^\S+ \S+ \S+ \S+ (#\d+)/.exec(text)?.[1] ?? ""}@${i}/${String(item.role)}`,
        ];
      return [];
    }),
  ].join(" ");
}
