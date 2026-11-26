// Hold a bounded, redacted review of optional export notes until the user confirms.
import { randomUUID } from "node:crypto";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { BrainRedactor } from "@pibot/brain/kit";
import type { ImportMemoryReview, ImportPreview } from "@pibot/import-contract";
import { MemorySchema, RpcError, RpcErrorCodes } from "@pibot/protocol-base";
import {
  type ImportMemories,
  type ImportMemoryScope,
  type MemorySelection,
  normalized,
  type ReviewedMemory,
} from "../store/memories.ts";
import type { ImportPersonas, PersonaSelection } from "../store/personas.ts";
import type { ImportInput } from "./adapter.ts";
import { exportItems } from "./exports/index.ts";
import { redactImportText } from "./records.ts";

export type ReviewedImport = {
  dto: ImportMemoryReview;
  botId: string;
  scope: ImportMemoryScope | "persona";
  records: ReviewedMemory[];
  personaHash?: string;
};

export async function reviewMemories(input: {
  preview: ImportPreview;
  input: ImportInput;
  botId: string;
  scope: ImportMemoryScope | "persona";
  memories: ImportMemories;
  personas: ImportPersonas;
  redactor: BrainRedactor;
  signal: AbortSignal;
}): Promise<ReviewedImport> {
  const { source } = input.preview;
  if (source !== "chatgpt" && source !== "claude")
    throw new RpcError(RpcErrorCodes.unsupported, "import_memory_source_unsupported");
  const records: ReviewedMemory[] = [];
  const seen = new Set<string>();
  const persona = input.scope === "persona" ? input.personas.current(input.botId) : undefined;
  if (persona && redactImportText(input.redactor, persona.text) !== persona.text)
    throw new RpcError(RpcErrorCodes.invalidParams, "import_persona_unavailable");
  const inspect =
    input.scope === "persona" ? undefined : input.memories.inspection(input.botId, input.scope);
  let omitted = 0;
  for await (const item of exportItems(source, input.input, input.signal)) {
    input.signal.throwIfAborted();
    if (item.kind !== "memories" && item.kind !== "customInstructions") continue;
    if (persona && item.kind !== "customInstructions") continue;
    const text = MemorySchema.shape.text.safeParse(redactImportText(input.redactor, item.text));
    if (!text.success || records.length >= 100 || seen.has(normalized(text.data))) {
      omitted++;
      continue;
    }
    seen.add(normalized(text.data));
    const candidate = {
      id: randomUUID(),
      text: text.data,
      category: item.kind === "memories" ? ("about_you" as const) : ("how_to" as const),
    };
    const reviewed = inspect?.(candidate) ?? {
      item: { ...candidate, outcome: "add" as const },
      conflict: "",
    };
    if (reviewed.item.existingText)
      reviewed.item.existingText = redactImportText(input.redactor, reviewed.item.existingText);
    records.push(reviewed);
    if (records.length % 8 === 0) await yieldToLoop(undefined, { signal: input.signal });
  }
  input.signal.throwIfAborted();
  return {
    dto: {
      reviewId: randomUUID(),
      items: records.map(({ item }) => item),
      omitted,
      ...(persona ? { personaBefore: redactImportText(input.redactor, persona.text) } : {}),
    },
    botId: input.botId,
    scope: input.scope,
    records,
    personaHash: persona?.hash,
  };
}

export function selectReview(
  review: ReviewedImport | undefined,
  botId: string,
  choice: { reviewId: string; selected: string[] },
): { memories?: MemorySelection; persona?: PersonaSelection } {
  if (!review || review.botId !== botId || review.dto.reviewId !== choice.reviewId)
    throw new RpcError(RpcErrorCodes.invalidParams, "import_memory_review_expired");
  const ids = new Set(choice.selected);
  const selected = review.records.filter(
    ({ item }) => ids.has(item.id) && item.outcome !== "duplicate",
  );
  if (ids.size !== choice.selected.length || ids.size !== selected.length)
    throw new RpcError(RpcErrorCodes.invalidParams, "import_memory_selection_invalid");
  if (review.scope !== "persona") return { memories: { scope: review.scope, selected } };
  if (!selected.length) return {};
  const text = selected.map(({ item }) => item.text).join("\n\n");
  if (!review.personaHash || text.length > 16_000)
    throw new RpcError(RpcErrorCodes.invalidParams, "import_persona_limit");
  return { persona: { expected: review.personaHash, text } };
}
