import { createHash } from "node:crypto";

type Json = Record<string, unknown>;
export interface Section {
  label: string;
  type: string;
  text: string;
  /** End of this section is a lookup/write boundary under GPT-5.6+ implicit caching. */
  eligible: boolean;
}

/**
 * Sections in render order (instructions, tools, input items) with GPT-5.6+ implicit-cache
 * eligibility, per OpenAI's prompt caching guide: user messages, the last tool output of a
 * consecutive run, and the end of the initial instructions/developer block. Later developer
 * messages, assistant items, reasoning and tool calls are not boundaries.
 */
export function responsesSections(body: Json): Section[] {
  const input = (body.input ?? []) as Json[];
  let initial = 0;
  while (initial < input.length && ["developer", "system"].includes(String(input[initial]?.role)))
    initial++;
  return [
    {
      label: "instructions",
      type: "instructions",
      text: JSON.stringify(body.instructions ?? ""),
      eligible: false,
    },
    // Tools render before the conversation; a codex request's top-level instructions + tools are
    // the initial block when the input has no leading developer messages.
    { label: "tools", type: "tools", text: JSON.stringify(body.tools ?? []), eligible: !initial },
    ...input.map((item, i) => {
      const type = String(item.type ?? item.role);
      const toolOutput = type === "function_call_output" || type === "custom_tool_call_output";
      const next = input[i + 1];
      const nextType = String(next?.type ?? next?.role);
      return {
        label: `input[${i}]`,
        type: item.role && item.type ? `${type}/${String(item.role)}` : type,
        text: JSON.stringify(item),
        eligible:
          item.role === "user" ||
          i === initial - 1 ||
          (toolOutput &&
            nextType !== "function_call_output" &&
            nextType !== "custom_tool_call_output"),
      };
    }),
  ];
}

/**
 * Longest common prefix of two requests as a share of the previous one, and where they first
 * differ (section label, item types, character offset inside the section).
 */
export function firstDifference(previous: Section[], next: Section[]) {
  const total = previous.reduce((sum, part) => sum + part.text.length, 0);
  let common = 0;
  for (let i = 0; i < previous.length; i++) {
    const a = previous[i] as Section;
    const b = next[i];
    if (!b)
      return { prefix: total ? common / total : 1, common, total, at: `${a.label} (removed)` };
    if (a.text === b.text) {
      common += a.text.length;
      continue;
    }
    let offset = 0;
    while (offset < a.text.length && a.text[offset] === b.text[offset]) offset++;
    common += offset;
    return {
      prefix: total ? common / total : 1,
      common,
      total,
      at: `first diff ${a.label} ${a.type} -> ${b.type} @${offset}/${a.text.length}`,
      offset,
      index: i,
    };
  }
  return { prefix: 1, common, total, at: "previous is a prefix" };
}

/**
 * Which cache rule to simulate.
 * - `guide`: OpenAI's documented GPT-5.6+ rule. Each request reads the longest boundary (latest
 *   eligible item, up to 20 earlier eligible endings, end of the initial block) whose prefix an
 *   earlier request wrote, then writes at its latest eligible item and the end of the initial
 *   block.
 * - `trailing`: what the ChatGPT (Codex) backend did on the owner's machine (cache diagnostics):
 *   the write lands at the request's last item whatever its role, plus the initial block; a later
 *   request reads the longest written prefix ending at any of its item boundaries. It reproduces
 *   both observations: a trailing developer state kept cacheRead at the initial block (7,808),
 *   a state pinned after the trigger made cacheRead grow with every request.
 */
export type CacheRule = "guide" | "trailing";

/** Simulated implicit cache over the requests of one conversation: cached / total characters. */
export function simulateImplicitCache(requests: Section[][], rule: CacheRule = "guide") {
  const written = new Set<string>();
  return requests.map((sections) => {
    const hash = createHash("sha256");
    const boundaries: { length: number; digest: string; eligible: boolean }[] = [];
    let length = 0;
    for (const section of sections) {
      hash.update(section.text);
      length += section.text.length;
      boundaries.push({ length, digest: hash.copy().digest("hex"), eligible: section.eligible });
    }
    const eligible = boundaries.filter((boundary) => boundary.eligible);
    const initial = eligible[0];
    const lookups =
      rule === "trailing" ? boundaries : [...eligible.slice(-21), ...(initial ? [initial] : [])];
    const cached = Math.max(
      0,
      ...lookups.filter((b) => written.has(b.digest)).map((boundary) => boundary.length),
    );
    const latest = rule === "trailing" ? boundaries.at(-1) : eligible.at(-1);
    if (latest) written.add(latest.digest);
    if (initial) written.add(initial.digest);
    return { cached, total: length };
  });
}
