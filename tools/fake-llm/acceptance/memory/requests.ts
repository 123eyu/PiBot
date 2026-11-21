import { parseMemoryDraft } from "../../../../packages/agent/src/runtime/memory-draft.ts";
import { parseExtractionDraft } from "../../../../packages/memory/src/brain/memory-extraction.ts";
import type { Reply } from "../../scenario.ts";

export type RequestKind = "chat" | "extraction" | "organization" | "other";
export interface RequestObservation {
  index: number;
  kind: RequestKind;
  catalog: boolean;
  tools: number;
  model: "task" | "aux" | "other";
  /** Whether each fixture marker string occurs in the request; booleans only, never the text. */
  markers: boolean[];
}

/** Fixed product instruction markers classify purpose, independent of the selected model ID. */
export function requestObservation(
  body: Record<string, unknown>,
  index: number,
  markers: readonly string[] = [],
): RequestObservation {
  const prompt = JSON.stringify({
    messages: body.messages,
    input: body.input,
    contents: body.contents,
    system: body.system,
    instructions: body.instructions,
    system_instruction: body.system_instruction,
    systemInstruction: body.systemInstruction,
  });
  const tools = Array.isArray(body.tools) ? body.tools.length : 0;
  const kind: RequestKind =
    tools > 0
      ? "chat"
      : prompt.includes("You maintain the long-term memory notes of an AI assistant.")
        ? "extraction"
        : prompt.includes("You curate the saved memory notes of an AI assistant.") ||
            prompt.includes(
              "You classify saved shared memory notes for an owner-initiated Sort into place run.",
            )
          ? "organization"
          : "other";
  return {
    index,
    kind,
    tools,
    catalog: prompt.includes("Memory catalog / 记忆目录"),
    model: body.model === "task" ? "task" : body.model === "aux" ? "aux" : "other",
    markers: markers.map((marker) => prompt.includes(marker)),
  };
}

/** Only shape/count crosses the diagnostic boundary; never the candidate or prompt text. */
export function extractionReplyShape(reply: Reply | undefined) {
  try {
    const parsed = parseExtractionDraft(parseMemoryDraft(reply?.text ?? ""));
    return { valid: true, candidates: parsed.candidates.length, dropped: parsed.dropped };
  } catch {
    return { valid: false, candidates: 0, dropped: 0 };
  }
}

export function requestSummary(requests: readonly RequestObservation[]) {
  const shown = requests
    .slice(0, 24)
    .map(
      (request) =>
        `${request.index}:${request.kind}:${request.model}:tools${request.tools}:catalog${Number(request.catalog)}`,
    );
  return `requests[${shown.join(",")}]${requests.length > shown.length ? `+${requests.length - shown.length}` : ""}`;
}
