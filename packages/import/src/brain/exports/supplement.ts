// Keep optional vendor text available to a future explicitly confirmed mapping step.
import { z } from "zod";
import { ImportFailure } from "../adapter.ts";

export type Supplement = {
  kind: "memories" | "customInstructions" | "projects";
  text: string;
  title?: string;
};

const text = z.string().max(65_536);
const memory = z.union([
  text,
  z.object({ memory: text }),
  z.object({ text }),
  z.object({ content: text }),
]);
const memories = z.object({ memories: z.array(memory).max(10_000) });
const instructions = z.object({
  about_user: text.optional(),
  about_model: text.optional(),
  custom_instructions: text.optional(),
  user_context: text.optional(),
  response_context: text.optional(),
});
const doc = z.object({ filename: z.string().optional(), content: text });
const project = z.object({
  name: z.string().optional(),
  prompt_template: text.nullish(),
  docs: z.array(doc).nullish(),
});

function* memoryItems(value: unknown): Generator<Supplement> {
  const nested = memories.safeParse(value);
  const values: unknown[] = nested.success ? nested.data.memories : [value];
  for (const candidate of values) {
    const item = memory.safeParse(candidate);
    if (!item.success) throw new ImportFailure("format");
    const row = item.data;
    const body =
      typeof row === "string"
        ? row
        : "memory" in row
          ? row.memory
          : "text" in row
            ? row.text
            : row.content;
    if (body.trim()) yield { kind: "memories", text: body };
  }
}

export function* supplementItems(kind: Supplement["kind"], value: unknown): Generator<Supplement> {
  if (kind === "memories") {
    yield* memoryItems(value);
    return;
  }
  if (kind === "customInstructions") {
    const parsed = instructions.safeParse(value);
    if (!parsed.success) throw new ImportFailure("format");
    for (const body of Object.values(parsed.data)) {
      if (body?.trim()) yield { kind, text: body };
    }
    return;
  }
  const parsed = project.safeParse(value);
  if (!parsed.success) throw new ImportFailure("format");
  const { name, prompt_template, docs } = parsed.data;
  if (prompt_template?.trim()) yield { kind, title: name, text: prompt_template };
  for (const { filename, content } of docs ?? []) {
    if (content.trim()) yield { kind, title: filename ?? name, text: content };
  }
}
